package backup

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"

	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/scrypt"
)

// Backup archives are either plain gzip-compressed pg_dump SQL (.sql.gz) or
// an authenticated, passphrase-encrypted stream (.sql.gz.enc). The encrypted
// format is self-contained: the file header carries the KDF salt and a
// passphrase verifier, so a copy of the backup plus the passphrase is enough
// to recover the database without this server's configuration.
const (
	backupVersion = 1

	backupMagicSize       = 8
	backupSaltSize        = 16
	backupNoncePrefixSize = 8
	backupVerifierNonce   = 12
	backupTagSize         = 16
	backupChunkSize       = 1 << 20

	scryptN = 1 << 15
	scryptR = 8
	scryptP = 1
)

const verifierText = "wireguard-console-backup-v1"

var (
	backupMagic = []byte{'W', 'G', 'C', 'B', 'K', '1', 0, 0}
	verifier    = []byte(verifierText)

	// ErrIncorrectPassphrase is returned when the archive is encrypted and
	// none of the supplied passphrases opens its verifier.
	ErrIncorrectPassphrase = errors.New("incorrect backup passphrase")
)

const (
	headerPrefixSize = backupMagicSize + 1 + backupSaltSize + backupNoncePrefixSize + backupVerifierNonce
	headerSize       = headerPrefixSize + len(verifierText) + backupTagSize
)

func deriveBackupKey(passphrase string, salt []byte) ([]byte, error) {
	return scrypt.Key([]byte(passphrase), salt, scryptN, scryptR, scryptP, chacha20poly1305.KeySize)
}

func newBackupAEAD(key []byte) (cipher.AEAD, error) {
	return chacha20poly1305.New(key)
}

// chunkNonce returns the 12-byte nonce for chunk index: an 8-byte random
// prefix followed by a big-endian 32-bit counter. Each chunk gets a unique
// nonce under the same key.
func chunkNonce(prefix []byte, counter uint32) []byte {
	nonce := make([]byte, chacha20poly1305.NonceSize)
	copy(nonce[:backupNoncePrefixSize], prefix)
	binary.BigEndian.PutUint32(nonce[backupNoncePrefixSize:], counter)
	return nonce
}

func writeFull(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}

type encryptWriter struct {
	w       io.Writer
	aead    cipher.AEAD
	prefix  []byte
	aad     []byte
	buf     []byte
	bufN    int
	sealed  []byte
	counter uint32
	closed  bool
}

// newEncryptWriter writes the archive header and returns a writer that
// encrypts each Write call as one or more authenticated chunks. Close is a
// no-op because every chunk is written immediately; the caller still closes
// the writer to signal completion.
func newEncryptWriter(w io.Writer, passphrase string) (*encryptWriter, error) {
	salt := make([]byte, backupSaltSize)
	prefix := make([]byte, backupNoncePrefixSize)
	vNonce := make([]byte, backupVerifierNonce)
	for _, b := range [][]byte{salt, prefix, vNonce} {
		if _, err := rand.Read(b); err != nil {
			return nil, fmt.Errorf("generate backup encryption material: %w", err)
		}
	}

	key, err := deriveBackupKey(passphrase, salt)
	if err != nil {
		return nil, fmt.Errorf("derive backup key: %w", err)
	}
	aead, err := newBackupAEAD(key)
	if err != nil {
		return nil, fmt.Errorf("initialise backup cipher: %w", err)
	}

	header := make([]byte, headerSize)
	off := 0
	copy(header[off:], backupMagic)
	off += backupMagicSize
	header[off] = backupVersion
	off++
	copy(header[off:], salt)
	off += backupSaltSize
	copy(header[off:], prefix)
	off += backupNoncePrefixSize
	copy(header[off:], vNonce)
	off += backupVerifierNonce
	aad := append([]byte(nil), header[:headerPrefixSize]...)
	sealedVerifier := aead.Seal(nil, vNonce, verifier, aad)
	if len(sealedVerifier) != len(verifier)+backupTagSize {
		return nil, errors.New("unexpected backup verifier length")
	}
	copy(header[off:], sealedVerifier)

	if err := writeFull(w, header); err != nil {
		return nil, fmt.Errorf("write backup header: %w", err)
	}
	return &encryptWriter{
		w:      w,
		aead:   aead,
		prefix: prefix,
		aad:    aad,
		buf:    make([]byte, backupChunkSize),
		sealed: make([]byte, 0, backupChunkSize+backupTagSize),
	}, nil
}

func (e *encryptWriter) flush() error {
	if e.bufN == 0 {
		return nil
	}
	nonce := chunkNonce(e.prefix, e.counter)
	e.counter++
	e.sealed = e.aead.Seal(e.sealed[:0], nonce, e.buf[:e.bufN], e.aad)
	if err := writeFull(e.w, e.sealed); err != nil {
		return err
	}
	e.bufN = 0
	return nil
}

func (e *encryptWriter) Write(p []byte) (int, error) {
	if e.closed {
		return 0, errors.New("write to closed backup encoder")
	}
	total := len(p)
	for len(p) > 0 {
		n := copy(e.buf[e.bufN:], p)
		e.bufN += n
		p = p[n:]
		if e.bufN == len(e.buf) {
			if err := e.flush(); err != nil {
				return total - len(p), err
			}
		}
	}
	return total, nil
}

func (e *encryptWriter) Close() error {
	if e.closed {
		return nil
	}
	e.closed = true
	return e.flush()
}

type decryptReader struct {
	r       io.Reader
	aead    cipher.AEAD
	prefix  []byte
	aad     []byte
	counter uint32
	cipher  []byte
	plain   []byte
	pending []byte
	done    bool
	err     error
}

// newDecryptReader reads and authenticates the header, trying each supplied
// passphrase against the verifier. Only the matching key proceeds to decrypt
// the body, so a wrong passphrase fails before any SQL is executed.
func newDecryptReader(r io.Reader, passphrases []string) (*decryptReader, error) {
	header := make([]byte, headerSize)
	if _, err := io.ReadFull(r, header); err != nil {
		return nil, fmt.Errorf("read backup header: %w", err)
	}
	if !bytes.Equal(header[:backupMagicSize], backupMagic) {
		return nil, errors.New("not a passphrase-encrypted backup")
	}
	if header[backupMagicSize] != backupVersion {
		return nil, fmt.Errorf("unsupported backup format version %d", header[backupMagicSize])
	}
	off := backupMagicSize + 1
	salt := header[off : off+backupSaltSize]
	off += backupSaltSize
	prefix := header[off : off+backupNoncePrefixSize]
	off += backupNoncePrefixSize
	vNonce := header[off : off+backupVerifierNonce]
	off += backupVerifierNonce
	aad := append([]byte(nil), header[:headerPrefixSize]...)
	sealedVerifier := header[off:]

	for _, passphrase := range passphrases {
		if passphrase == "" {
			continue
		}
		key, err := deriveBackupKey(passphrase, salt)
		if err != nil {
			continue
		}
		aead, err := newBackupAEAD(key)
		if err != nil {
			continue
		}
		if _, err := aead.Open(nil, vNonce, sealedVerifier, aad); err != nil {
			continue
		}
		return &decryptReader{
			r:      r,
			aead:   aead,
			prefix: append([]byte(nil), prefix...),
			aad:    aad,
			cipher: make([]byte, backupChunkSize+backupTagSize),
			plain:  make([]byte, backupChunkSize),
		}, nil
	}
	return nil, ErrIncorrectPassphrase
}

func (d *decryptReader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if len(d.pending) > 0 {
		n := copy(p, d.pending)
		d.pending = d.pending[n:]
		return n, nil
	}
	if d.err != nil {
		return 0, d.err
	}
	if d.done {
		return 0, io.EOF
	}

	n, err := io.ReadFull(d.r, d.cipher)
	if n == 0 {
		if err == io.EOF {
			d.done = true
			return 0, io.EOF
		}
		d.err = fmt.Errorf("read backup chunk: %w", err)
		return 0, d.err
	}
	if n < backupTagSize {
		d.err = errors.New("encrypted backup is truncated")
		return 0, d.err
	}
	terminal := err != nil || n < len(d.cipher)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		d.err = fmt.Errorf("read backup chunk: %w", err)
		return 0, d.err
	}

	nonce := chunkNonce(d.prefix, d.counter)
	d.counter++
	plain, openErr := d.aead.Open(d.plain[:0], nonce, d.cipher[:n], d.aad)
	if openErr != nil {
		d.err = errors.New("encrypted backup is corrupted or truncated")
		return 0, d.err
	}
	d.pending = plain
	if terminal {
		d.done = true
	}
	return d.Read(p)
}

type compositeReadCloser struct {
	io.Reader
	closers []io.Closer
}

func (c *compositeReadCloser) Close() error {
	var first error
	for _, closer := range c.closers {
		if err := closer.Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// IsEncryptedFile reports whether path begins with the passphrase-encrypted
// archive magic. It reads only the header prefix.
func IsEncryptedFile(path string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	head := make([]byte, len(backupMagic))
	if _, err := io.ReadFull(f, head); err != nil {
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			return false, nil
		}
		return false, err
	}
	return bytes.Equal(head, backupMagic), nil
}

// OpenBackupSQL opens a plain or encrypted backup and decompresses it into a
// streaming SQL reader. For an encrypted archive, passphrases are tried in
// order; old passphrases retained by the console make older backups readable
// after a passphrase change. The caller must close the returned reader.
func OpenBackupSQL(path string, passphrases []string) (io.ReadCloser, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	br := bufio.NewReaderSize(f, 64*1024)
	head, _ := br.Peek(len(backupMagic))
	var src io.Reader = br
	if bytes.Equal(head, backupMagic) {
		dec, err := newDecryptReader(br, passphrases)
		if err != nil {
			f.Close()
			return nil, err
		}
		src = dec
	}
	gz, err := gzip.NewReader(src)
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("open compressed backup: %w", err)
	}
	return &compositeReadCloser{
		Reader:  gz,
		closers: []io.Closer{gz, f},
	}, nil
}

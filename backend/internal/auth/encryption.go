package auth

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
)

type EncryptionService struct {
	key []byte
}

func NewEncryptionService() (*EncryptionService, error) {
	keyHex := os.Getenv("APP_ENCRYPTION_KEY")
	if keyHex == "" {
		return nil, fmt.Errorf("APP_ENCRYPTION_KEY environment variable is required")
	}

	key, err := hex.DecodeString(keyHex)
	if err != nil {
		return nil, fmt.Errorf("failed to decode APP_ENCRYPTION_KEY: %w", err)
	}

	if len(key) != 32 {
		return nil, fmt.Errorf("APP_ENCRYPTION_KEY must be 32 bytes (64 hex chars), got %d bytes", len(key))
	}

	return &EncryptionService{key: key}, nil
}

func (e *EncryptionService) Encrypt(plaintext string) (string, error) {
	block, err := aes.NewCipher(e.key)
	if err != nil {
		return "", fmt.Errorf("failed to create cipher: %w", err)
	}

	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("failed to create GCM: %w", err)
	}

	nonce := make([]byte, aesGCM.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("failed to generate nonce: %w", err)
	}

	ciphertext := aesGCM.Seal(nonce, nonce, []byte(plaintext), nil)
	return hex.EncodeToString(ciphertext), nil
}

func (e *EncryptionService) Decrypt(ciphertextHex string) (string, error) {
	block, err := aes.NewCipher(e.key)
	if err != nil {
		return "", fmt.Errorf("failed to create cipher: %w", err)
	}

	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("failed to create GCM: %w", err)
	}

	ciphertext, err := hex.DecodeString(ciphertextHex)
	if err != nil {
		return "", fmt.Errorf("failed to decode ciphertext: %w", err)
	}

	nonceSize := aesGCM.NonceSize()
	if len(ciphertext) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}

	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	plaintext, err := aesGCM.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("failed to decrypt: %w", err)
	}

	return string(plaintext), nil
}

func GetSecretKey() string {
	return os.Getenv("APP_ENCRYPTION_KEY")
}

func EncryptTOTPSecret(store context.Context, secret string) (string, error) {
	encService, err := NewEncryptionService()
	if err != nil {
		return "", err
	}

	return encService.Encrypt(secret)
}

func DecryptTOTPSecret(store context.Context, encrypted string) (string, error) {
	encService, err := NewEncryptionService()
	if err != nil {
		return "", err
	}

	return encService.Decrypt(encrypted)
}

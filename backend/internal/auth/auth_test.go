package auth

import (
	"os"
	"testing"
)

func TestEncryptionRoundTrip(t *testing.T) {
	os.Setenv("APP_ENCRYPTION_KEY", "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899")
	defer os.Unsetenv("APP_ENCRYPTION_KEY")

	svc, err := NewEncryptionService()
	if err != nil {
		t.Fatalf("NewEncryptionService: %v", err)
	}

	secret := "super-secret-wg-private-key"
	enc, err := svc.Encrypt(secret)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if enc == secret {
		t.Fatal("ciphertext must differ from plaintext")
	}
	if len(enc) < 40 {
		t.Fatalf("ciphertext suspiciously short: %d", len(enc))
	}

	dec, err := svc.Decrypt(enc)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if dec != secret {
		t.Fatalf("round trip mismatch: got %q want %q", dec, secret)
	}
}

func TestEncryptionWrongKeyFails(t *testing.T) {
	os.Setenv("APP_ENCRYPTION_KEY", "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899")
	defer os.Unsetenv("APP_ENCRYPTION_KEY")

	svc, _ := NewEncryptionService()
	enc, err := svc.Encrypt("secret")
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}

	os.Setenv("APP_ENCRYPTION_KEY", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
	other, _ := NewEncryptionService()
	if _, err := other.Decrypt(enc); err == nil {
		t.Fatal("decrypting with the wrong key must fail")
	}
}

func TestEncryptionRequires32ByteKey(t *testing.T) {
	os.Setenv("APP_ENCRYPTION_KEY", "short")
	defer os.Unsetenv("APP_ENCRYPTION_KEY")

	if _, err := NewEncryptionService(); err == nil {
		t.Fatal("short key must be rejected")
	}
}

func TestValidatePasswordRules(t *testing.T) {
	cases := []struct {
		pw   string
		want string // expected substring of the error, "" = valid
	}{
		{"short", "at least 12"},
		{"alllowercase123!", "uppercase"},
		{"ALLUPPERCASE123!", "lowercase"},
		{"NoDigitsHere!!", "number"},
		{"NoSpecial123", "special"},
	}
	for _, c := range cases {
		err := ValidatePassword(c.pw)
		if err == nil {
			t.Errorf("ValidatePassword(%q): expected error containing %q", c.pw, c.want)
			continue
		}
		if !contains(err.Error(), c.want) {
			t.Errorf("ValidatePassword(%q) error %q does not mention %q", c.pw, err.Error(), c.want)
		}
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

package auth

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

func GenerateTOTP() (*otp.Key, error) {
	secret, err := totp.Generate(totp.GenerateOpts{
		Issuer:      "WireGuard Console",
		AccountName: "admin",
		Period:      30,
		Digits:      otp.DigitsSix,
		Algorithm:   otp.AlgorithmSHA1,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to generate TOTP: %w", err)
	}

	return secret, nil
}

func VerifyTOTP(secret, code string) bool {
	return totp.Validate(code, secret)
}

func GenerateBackupCodes(count int) ([]string, error) {
	codes := make([]string, count)
	for i := 0; i < count; i++ {
		b := make([]byte, 5)
		if _, err := rand.Read(b); err != nil {
			return nil, fmt.Errorf("failed to generate random bytes: %w", err)
		}
		codes[i] = hex.EncodeToString(b)[:8]
	}
	return codes, nil
}

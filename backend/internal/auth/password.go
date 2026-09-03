package auth

import (
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type HaveIBeenPwnedResponse struct {
	Hash  string `json:"hash"`
	Count int    `json:"count"`
}

func CheckPasswordBreached(password string) (bool, error) {
	// Hash password with SHA1 (for k-anonymity API)
	hash := sha256.Sum256([]byte(password))
	hashStr := fmt.Sprintf("%x", hash)
	prefix := hashStr[:5]
	suffix := hashStr[5:]

	// Query HaveIBeenPwned API
	url := fmt.Sprintf("https://api.pwnedpasswords.com/range/%s", prefix)
	resp, err := http.Get(url)
	if err != nil {
		return false, fmt.Errorf("failed to query HaveIBeenPwned: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, fmt.Errorf("failed to read response: %w", err)
	}

	// Parse response and check if our hash suffix exists
	lines := strings.Split(string(body), "\n")
	for _, line := range lines {
		parts := strings.Split(strings.TrimSpace(line), ":")
		if len(parts) == 2 && parts[0] == suffix {
			count, _ := fmt.Sscanf(parts[1], "%d", new(int))
			return count > 0, nil
		}
	}

	return false, nil
}

func ValidatePassword(password string) error {
	if len(password) < 12 {
		return fmt.Errorf("password must be at least 12 characters")
	}

	if !strings.ContainsAny(password, "abcdefghijklmnopqrstuvwxyz") {
		return fmt.Errorf("password must contain at least one lowercase letter")
	}

	if !strings.ContainsAny(password, "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
		return fmt.Errorf("password must contain at least one uppercase letter")
	}

	if !strings.ContainsAny(password, "0123456789") {
		return fmt.Errorf("password must contain at least one number")
	}

	if !strings.ContainsAny(password, "!@#$%^&*()_+-=[]{}|;:',.<>?") {
		return fmt.Errorf("password must contain at least one special character")
	}

	breached, err := CheckPasswordBreached(password)
	if err != nil {
		return fmt.Errorf("failed to check password: %w", err)
	}

	if breached {
		return fmt.Errorf("password has been found in a data breach")
	}

	return nil
}

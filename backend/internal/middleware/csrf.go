package middleware

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

type contextKey string

const csrfTokenKey contextKey = "csrf_token"

func GenerateCSRFToken() string {
	signingKey := os.Getenv("SESSION_SIGNING_KEY")
	if signingKey == "" {
		signingKey = "default-signing-key-change-in-production"
	}

	timestamp := time.Now().Unix()
	data := fmt.Sprintf("%d", timestamp)

	mac := hmac.New(sha256.New, []byte(signingKey))
	mac.Write([]byte(data))
	signature := mac.Sum(nil)

	return hex.EncodeToString([]byte(data)) + "." + hex.EncodeToString(signature)
}

func ValidateCSRFToken(token string) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return false
	}

	data, err := hex.DecodeString(parts[0])
	if err != nil {
		return false
	}

	signature, err := hex.DecodeString(parts[1])
	if err != nil {
		return false
	}

	signingKey := os.Getenv("SESSION_SIGNING_KEY")
	if signingKey == "" {
		signingKey = "default-signing-key-change-in-production"
	}

	mac := hmac.New(sha256.New, []byte(signingKey))
	mac.Write(data)
	expectedSignature := mac.Sum(nil)

	return hmac.Equal(signature, expectedSignature)
}

func CSRFProtection(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip CSRF check for non-state-changing methods
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}

		// Check for CSRF token in header or form
		token := r.Header.Get("X-CSRF-Token")
		if token == "" {
			token = r.FormValue("_csrf")
		}

		if !ValidateCSRFToken(token) {
			http.Error(w, "CSRF validation failed", http.StatusForbidden)
			return
		}

		ctx := context.WithValue(r.Context(), csrfTokenKey, token)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func GetCSRFToken(r *http.Request) string {
	token, _ := r.Context().Value(csrfTokenKey).(string)
	return token
}

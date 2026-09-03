package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wireguard-console/backend/internal/auth"
	"github.com/wireguard-console/backend/internal/db"
	"golang.org/x/crypto/argon2"
)

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func hashPassword(password string) string {
	salt := make([]byte, 16)
	rand.Read(salt)

	hash := argon2.IDKey(
		[]byte(password),
		salt,
		1<<15, 1, 4,
		32,
	)

	return hex.EncodeToString(salt) + ":" + hex.EncodeToString(hash)
}

func verifyPassword(password, hash string) bool {
	parts := strings.Split(hash, ":")
	if len(parts) != 2 {
		return false
	}

	salt, err := hex.DecodeString(parts[0])
	if err != nil {
		return false
	}

	hashBytes, err := hex.DecodeString(parts[1])
	if err != nil {
		return false
	}

	computedHash := argon2.IDKey(
		[]byte(password),
		salt,
		1<<15, 1, 4,
		uint32(len(hashBytes)),
	)

	return subtleConstantTimeCompare(hashBytes, computedHash)
}

func subtleConstantTimeCompare(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := range a {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func generateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type verify2FARequest struct {
	Code string `json:"code"`
}

type setup2FARequest struct {
	Code string `json:"code"`
}

type enable2FARequest struct {
	Code string `json:"code"`
}

type adminResponse struct {
	ID          uuid.UUID `json:"id"`
	Email       string    `json:"email"`
	Role        string    `json:"role"`
	TOTPEnabled bool      `json:"totp_enabled"`
	Status      string    `json:"status"`
	CreatedAt   time.Time `json:"created_at"`
}

type sessionResponse struct {
	Token string `json:"token"`
}

type loginResponse struct {
	Token      string         `json:"token,omitempty"`
	Pending2FA bool           `json:"pending_2fa,omitempty"`
	Admin      *adminResponse `json:"admin,omitempty"`
}

func Login(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		clientIP := getClientIP(r)
		if loginRateLimiter.isLimited(clientIP) {
			writeError(w, http.StatusTooManyRequests, "Too many login attempts. Please try again later.")
			return
		}

		var req loginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()

		var admin db.Admin
		err := store.pool.QueryRow(ctx, `
			SELECT id, email, password_hash, role, totp_enabled, status, failed_login_count, locked_until, last_login_at, created_at, updated_at
			FROM admins
			WHERE email = $1
		`, req.Email).Scan(
			&admin.ID, &admin.Email, &admin.PasswordHash, &admin.Role,
			&admin.TOTPEnabled, &admin.Status, &admin.FailedLoginCount,
			&admin.LockedUntil, &admin.LastLoginAt, &admin.CreatedAt, &admin.UpdatedAt,
		)

		if err != nil {
			writeJSON(w, http.StatusUnauthorized, loginResponse{})
			return
		}

		if admin.Status == "disabled" {
			writeError(w, http.StatusForbidden, "Account is disabled")
			return
		}

		if admin.LockedUntil != nil && time.Now().Before(*admin.LockedUntil) {
			writeError(w, http.StatusTooManyRequests, "Account is temporarily locked")
			return
		}

		if !verifyPassword(req.Password, admin.PasswordHash) {
			log.Printf("Password verification failed for admin: %s", admin.Email)
			admin.FailedLoginCount++
			if admin.FailedLoginCount >= 5 {
				lockUntil := time.Now().Add(15 * time.Minute)
				admin.LockedUntil = &lockUntil
				admin.FailedLoginCount = 0
			}
			store.pool.Exec(ctx, `
				UPDATE admins 
				SET failed_login_count = $1, locked_until = $2, updated_at = now()
				WHERE id = $3
			`, admin.FailedLoginCount, admin.LockedUntil, admin.ID)

			writeJSON(w, http.StatusUnauthorized, loginResponse{})
			return
		}

		admin.FailedLoginCount = 0
		admin.LockedUntil = nil
		now := time.Now()
		admin.LastLoginAt = &now
		store.pool.Exec(ctx, `
			UPDATE admins 
			SET failed_login_count = 0, locked_until = NULL, last_login_at = $1, updated_at = now()
			WHERE id = $2
		`, now, admin.ID)

		resp := loginResponse{
			Admin: &adminResponse{
				ID:          admin.ID,
				Email:       admin.Email,
				Role:        admin.Role,
				TOTPEnabled: admin.TOTPEnabled,
				Status:      admin.Status,
				CreatedAt:   admin.CreatedAt,
			},
		}

		if admin.TOTPEnabled {
			token, err := generateToken()
			if err != nil {
				log.Printf("Failed to generate 2FA token: %v", err)
				writeError(w, http.StatusInternalServerError, "Failed to generate token")
				return
			}
			resp.Pending2FA = true
			resp.Token = token
		} else {
			sessionToken, err := generateToken()
			if err != nil {
				log.Printf("Failed to generate session token: %v", err)
				writeError(w, http.StatusInternalServerError, "Failed to generate token")
				return
			}

			tokenHash := hashToken(sessionToken)
			expiresAt := time.Now().Add(24 * time.Hour)

			// Extract just the IP address from RemoteAddr (host:port)
			ip := r.RemoteAddr
			if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
				ip = host
			}

			log.Printf("Creating session: admin_id=%s, token_hash=%s, ip=%s", admin.ID, tokenHash, ip)

			_, err = store.pool.Exec(ctx, `
				INSERT INTO admin_sessions (admin_id, token_hash, ip_address, user_agent, expires_at)
				VALUES ($1, $2, $3, $4, $5)
			`, admin.ID, tokenHash, ip, r.UserAgent(), expiresAt)

			if err != nil {
				log.Printf("Failed to create session: admin_id=%s, err=%v", admin.ID, err)
				writeError(w, http.StatusInternalServerError, "Failed to create session")
				return
			}

			resp.Token = sessionToken
		}

		writeJSON(w, http.StatusOK, resp)
	}
}

func Verify2FA(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req verify2FARequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		token := r.Header.Get("Authorization")
		if token == "" {
			writeError(w, http.StatusUnauthorized, "Missing authorization token")
			return
		}

		ctx := context.Background()

		var admin db.Admin
		err := store.pool.QueryRow(ctx, `
			SELECT id, email, password_hash, role, totp_enabled, status, totp_secret_encrypted
			FROM admins
			WHERE id = (SELECT admin_id FROM admin_sessions WHERE token_hash = $1 AND expires_at > now())
		`, hashToken(token)).Scan(
			&admin.ID, &admin.Email, &admin.PasswordHash, &admin.Role,
			&admin.TOTPEnabled, &admin.Status, &admin.TOTPSecretEncrypted,
		)

		if err != nil {
			writeError(w, http.StatusUnauthorized, "Invalid or expired token")
			return
		}

		if !admin.TOTPEnabled {
			writeError(w, http.StatusBadRequest, "2FA is not enabled for this account")
			return
		}

		decryptedSecret, err := auth.DecryptTOTPSecret(ctx, admin.TOTPSecretEncrypted)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to decrypt TOTP secret")
			return
		}

		if !auth.VerifyTOTP(decryptedSecret, req.Code) {
			writeError(w, http.StatusBadRequest, "Invalid verification code")
			return
		}

		sessionToken, err := generateToken()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to generate token")
			return
		}

		tokenHash := hashToken(sessionToken)
		expiresAt := time.Now().Add(24 * time.Hour)

		_, err = store.pool.Exec(ctx, `
			INSERT INTO admin_sessions (admin_id, token_hash, ip_address, user_agent, expires_at)
			VALUES ($1, $2, $3, $4, $5)
		`, admin.ID, tokenHash, r.RemoteAddr, r.UserAgent(), expiresAt)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create session")
			return
		}

		writeJSON(w, http.StatusOK, sessionResponse{Token: sessionToken})
	}
}

func Logout(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("Authorization")
		if token == "" {
			writeError(w, http.StatusUnauthorized, "Missing authorization token")
			return
		}

		ctx := context.Background()
		store.pool.Exec(ctx, `
			DELETE FROM admin_sessions WHERE token_hash = $1
		`, hashToken(token))

		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

func AuthMiddleware(store *Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := r.Header.Get("Authorization")
			if token == "" {
				writeError(w, http.StatusUnauthorized, "Missing authorization token")
				return
			}

			ctx := context.Background()

			var adminID uuid.UUID
			err := store.pool.QueryRow(ctx, `
				SELECT admin_id FROM admin_sessions 
				WHERE token_hash = $1 AND expires_at > now()
			`, hashToken(token)).Scan(&adminID)

			if err != nil {
				writeError(w, http.StatusUnauthorized, "Invalid or expired session")
				return
			}

			ctx = context.WithValue(ctx, "admin_id", adminID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func getAdminID(r *http.Request) uuid.UUID {
	adminID, _ := r.Context().Value("admin_id").(uuid.UUID)
	return adminID
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func parseUUID(s string) (uuid.UUID, error) {
	return uuid.Parse(s)
}

func getClientIP(r *http.Request) string {
	forwarded := r.Header.Get("X-Forwarded-For")
	if forwarded != "" {
		return strings.Split(forwarded, ",")[0]
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return ip
}

func logAudit(ctx context.Context, store *Store, adminID uuid.UUID, action, targetType, targetID string, metadata interface{}) {
	metaJSON, _ := json.Marshal(metadata)
	store.pool.Exec(ctx, `
		INSERT INTO audit_logs (actor_admin_id, action, target_type, target_id, metadata, ip_address)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, adminID, action, targetType, targetID, string(metaJSON), nil)
}

type rateLimiter struct {
	mu          sync.Mutex
	attempts    map[string][]time.Time
	window      time.Duration
	maxAttempts int
}

func newRateLimiter(window time.Duration, maxAttempts int) *rateLimiter {
	return &rateLimiter{
		attempts:    make(map[string][]time.Time),
		window:      window,
		maxAttempts: maxAttempts,
	}
}

func (rl *rateLimiter) isLimited(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-rl.window)

	var valid []time.Time
	for _, t := range rl.attempts[key] {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}

	rl.attempts[key] = valid

	if len(valid) >= rl.maxAttempts {
		return true
	}

	rl.attempts[key] = append(rl.attempts[key], now)
	return false
}

var loginRateLimiter = newRateLimiter(15*time.Minute, 5)

func Setup2FA(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID := getAdminID(r)

		ctx := context.Background()

		var totpEnabled bool
		store.pool.QueryRow(ctx, `SELECT totp_enabled FROM admins WHERE id = $1`, adminID).Scan(&totpEnabled)

		if totpEnabled {
			writeError(w, http.StatusBadRequest, "2FA is already enabled")
			return
		}

		totp, err := auth.GenerateTOTP()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to generate TOTP")
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"secret":      totp.Secret(),
			"otpauth_url": totp.URL(),
			"qr_code_url": totp.URL(),
		})
	}
}

func Enable2FA(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Secret string `json:"secret"`
			Code   string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		adminID := getAdminID(r)
		ctx := context.Background()

		var totpEnabled bool
		store.pool.QueryRow(ctx, `SELECT totp_enabled FROM admins WHERE id = $1`, adminID).Scan(&totpEnabled)

		if totpEnabled {
			writeError(w, http.StatusBadRequest, "2FA is already enabled")
			return
		}

		if !auth.VerifyTOTP(req.Secret, req.Code) {
			writeError(w, http.StatusBadRequest, "Invalid verification code")
			return
		}

		encryptedSecret, err := auth.EncryptTOTPSecret(ctx, req.Secret)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to encrypt secret")
			return
		}

		backupCodes, err := auth.GenerateBackupCodes(10)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to generate backup codes")
			return
		}

		codesHash := make([]string, len(backupCodes))
		for i, code := range backupCodes {
			h := sha256.Sum256([]byte(code))
			codesHash[i] = hex.EncodeToString(h[:])
		}

		_, err = store.pool.Exec(ctx, `
			UPDATE admins 
			SET totp_secret_encrypted = $1, totp_enabled = true, backup_codes_hash = $2, updated_at = now()
			WHERE id = $3
		`, encryptedSecret, codesHash, adminID)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to enable 2FA")
			return
		}

		logAudit(ctx, store, adminID, "2fa.enable", "admin", adminID.String(), nil)

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"backup_codes": backupCodes,
			"message":      "2FA enabled. Save these backup codes - they can only be shown once.",
		})
	}
}

func RequireRole(store *Store, roles ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			adminID := getAdminID(r)
			ctx := context.Background()

			var role string
			err := store.pool.QueryRow(ctx, `SELECT role FROM admins WHERE id = $1`, adminID).Scan(&role)
			if err != nil {
				writeError(w, http.StatusForbidden, "Access denied")
				return
			}

			for _, allowed := range roles {
				if role == allowed {
					next.ServeHTTP(w, r)
					return
				}
			}

			writeError(w, http.StatusForbidden, "Insufficient permissions")
		})
	}
}

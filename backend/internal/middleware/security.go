package middleware

import (
	"net/http"
)

func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Content Security Policy
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self' 'unsafe-inline' 'unsafe-eval'; "+
				"style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data: https:; "+
				"font-src 'self' data:; "+
				"connect-src 'self' https://api.pwnedpasswords.com; "+
				"frame-ancestors 'none'; "+
				"base-uri 'self'; "+
				"form-action 'self'")

		// Strict Transport Security
		w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload")

		// X-Frame-Options
		w.Header().Set("X-Frame-Options", "DENY")

		// X-Content-Type-Options
		w.Header().Set("X-Content-Type-Options", "nosniff")

		// X-XSS-Protection
		w.Header().Set("X-XSS-Protection", "1; mode=block")

		// Referrer Policy
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")

		// Permissions Policy
		w.Header().Set("Permissions-Policy",
			"camera=(), microphone=(), geolocation=()")

		next.ServeHTTP(w, r)
	})
}

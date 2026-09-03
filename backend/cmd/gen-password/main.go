package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"

	"golang.org/x/crypto/argon2"
)

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

func main() {
	if len(os.Args) < 2 {
		fmt.Println("Usage: go run gen-password.go <password>")
		os.Exit(1)
	}

	password := os.Args[1]
	hash := hashPassword(password)
	fmt.Printf("Email: admin@company.com\n")
	fmt.Printf("Password: %s\n", password)
	fmt.Printf("Hash: %s\n", hash)
	fmt.Printf("\nSQL:\n")
	fmt.Printf("INSERT INTO admins (email, password_hash, role, status) VALUES ('admin@company.com', '%s', 'super_admin', 'active');\n", hash)
}

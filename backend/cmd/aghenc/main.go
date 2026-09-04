// aghenc prints the bcrypt hash of a password for AdGuard Home's
// AdGuardHome.yaml "users: [{name, password}]" section.
//
// Usage: aghenc <username> <password>
// Output: <username>:<bcrypt-hash>  (compatible with AGH password field)
package main

import (
	"fmt"
	"os"

	"golang.org/x/crypto/bcrypt"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: aghenc <username> <password>")
		os.Exit(1)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(os.Args[2]), bcrypt.DefaultCost)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bcrypt:", err)
		os.Exit(1)
	}
	fmt.Printf("%s:%s\n", os.Args[1], string(hash))
}

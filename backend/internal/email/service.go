package email

import (
	"fmt"
	"net/smtp"
	"os"
)

type Config struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
}

type Service struct {
	config *Config
}

func NewService() (*Service, error) {
	host := os.Getenv("SMTP_HOST")
	port := 587
	username := os.Getenv("SMTP_USERNAME")
	password := os.Getenv("SMTP_PASSWORD")
	from := os.Getenv("SMTP_FROM_ADDRESS")

	if host == "" {
		return nil, fmt.Errorf("SMTP_HOST environment variable is required")
	}

	return &Service{
		config: &Config{
			Host:     host,
			Port:     port,
			Username: username,
			Password: password,
			From:     from,
		},
	}, nil
}

func (s *Service) Send(to, subject, body string) error {
	auth := smtp.PlainAuth("", s.config.Username, s.config.Password, s.config.Host)

	msg := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n%s",
		s.config.From, to, subject, body)

	return smtp.SendMail(
		fmt.Sprintf("%s:%d", s.config.Host, s.config.Port),
		auth,
		s.config.From,
		[]string{to},
		[]byte(msg),
	)
}

func (s *Service) SendUserInvite(to, fullName, inviteLink string) error {
	subject := "You've been invited to join WireGuard Console"
	body := fmt.Sprintf(`
		<html>
		<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
			<h2>Welcome to WireGuard Console</h2>
			<p>Hello %s,</p>
			<p>An administrator has invited you to join the WireGuard Console. Click the link below to claim your account and set up your VPN access.</p>
			<p><a href="%s" style="display: inline-block; padding: 12px 24px; background-color: #0d9488; color: white; text-decoration: none; border-radius: 6px; font-weight: bold;">Claim Account</a></p>
			<p style="margin-top: 24px; color: #666; font-size: 14px;">
				If you didn't request this invitation, you can safely ignore this email.
			</p>
		</body>
		</html>
	`, fullName, inviteLink)

	return s.Send(to, subject, body)
}

func (s *Service) SendAdminInvite(to, fullName, setupLink string) error {
	subject := "You've been invited to manage WireGuard Console"
	body := fmt.Sprintf(`
		<html>
		<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
			<h2>Welcome to WireGuard Console</h2>
			<p>Hello %s,</p>
			<p>An administrator has invited you to join as a console administrator. Click the link below to set up your account.</p>
			<p><a href="%s" style="display: inline-block; padding: 12px 24px; background-color: #0d9488; color: white; text-decoration: none; border-radius: 6px; font-weight: bold;">Setup Account</a></p>
			<p style="margin-top: 24px; color: #666; font-size: 14px;">
				If you didn't request this invitation, you can safely ignore this email.
			</p>
		</body>
		</html>
	`, fullName, setupLink)

	return s.Send(to, subject, body)
}

func (s *Service) SendTestEmail(to string) error {
	subject := "WireGuard Console - Test Email"
	body := `
		<html>
		<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
			<h2>Test Email</h2>
			<p>If you're reading this, your SMTP configuration is working correctly.</p>
		</body>
		</html>
	`

	return s.Send(to, subject, body)
}

package db

import (
	"database/sql"
	"time"

	"github.com/google/uuid"
)

type Admin struct {
	ID                  uuid.UUID  `json:"id"`
	Email               string     `json:"email"`
	PasswordHash        string     `json:"-"`
	Role                string     `json:"role"`
	TOTPSecretEncrypted string     `json:"totp_secret_encrypted"`
	TOTPEnabled         bool       `json:"totp_enabled"`
	Status              string     `json:"status"`
	FailedLoginCount    int        `json:"failed_login_count"`
	LockedUntil         *time.Time `json:"locked_until"`
	LastLoginAt         *time.Time `json:"last_login_at"`
	CreatedAt           time.Time  `json:"created_at"`
	UpdatedAt           time.Time  `json:"updated_at"`
}

type AdminSession struct {
	ID        uuid.UUID `json:"id"`
	AdminID   uuid.UUID `json:"admin_id"`
	TokenHash string    `json:"token_hash"`
	IPAddress string    `json:"ip_address"`
	UserAgent string    `json:"user_agent"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

type User struct {
	ID          uuid.UUID  `json:"id"`
	Email       string     `json:"email"`
	FullName    string     `json:"full_name"`
	Status      string     `json:"status"`
	InvitedBy   *uuid.UUID `json:"invited_by"`
	InvitedAt   *time.Time `json:"invited_at"`
	ActivatedAt *time.Time `json:"activated_at"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

type Peer struct {
	ID              uuid.UUID  `json:"id"`
	UserID          uuid.UUID  `json:"user_id"`
	ServerID        uuid.UUID  `json:"server_id"`
	Name            string     `json:"name"`
	PublicKey       string     `json:"public_key"`
	AllowedIP       string     `json:"allowed_ip"`
	Status          string     `json:"status"`
	LastHandshakeAt *time.Time `json:"last_handshake_at"`
	CreatedAt       time.Time  `json:"created_at"`
	SuspendedAt     *time.Time `json:"suspended_at"`
	RemovedAt       *time.Time `json:"removed_at"`
}

type Server struct {
	ID                  uuid.UUID `json:"id"`
	Name                string    `json:"name"`
	PublicEndpoint      string    `json:"public_endpoint"`
	ListenPort          int       `json:"listen_port"`
	InterfaceName       string    `json:"interface_name"`
	ServerPublicKey     string    `json:"server_public_key"`
	NetworkCIDR         string    `json:"network_cidr"`
	DNSServers          []string  `json:"dns_servers"`
	DefaultAllowedIPs   string    `json:"default_allowed_ips"`
	MTU                 int       `json:"mtu"`
	PersistentKeepalive int       `json:"persistent_keepalive"`
	Status              string    `json:"status"`
	CreatedAt           time.Time `json:"created_at"`
}

type DomainRule struct {
	ID        uuid.UUID  `json:"id"`
	Scope     string     `json:"scope"`
	UserID    *uuid.UUID `json:"user_id"`
	Domain    string     `json:"domain"`
	CreatedBy *uuid.UUID `json:"created_by"`
	CreatedAt time.Time  `json:"created_at"`
}

type AuditLog struct {
	ID           int64          `json:"id"`
	ActorAdminID *uuid.UUID     `json:"actor_admin_id"`
	Action       string         `json:"action"`
	TargetType   *string        `json:"target_type"`
	TargetID     *string        `json:"target_id"`
	Metadata     sql.NullString `json:"metadata"`
	IPAddress    *string        `json:"ip_address"`
	CreatedAt    time.Time      `json:"created_at"`
}

type StatsOverview struct {
	TotalPeers     int `json:"total_peers"`
	ActivePeers    int `json:"active_peers"`
	SuspendedPeers int `json:"suspended_peers"`
	TotalUsers     int `json:"total_users"`
	ActiveUsers    int `json:"active_users"`
	TotalServers   int `json:"total_servers"`
	ConnectedPeers int `json:"connected_peers"`
}

# WireGuard Console

A self-hosted, production-grade web console for issuing, monitoring, and revoking company WireGuard VPN access.

## Features

- **Multi-admin support** with role-based access control (super_admin, admin, auditor)
- **Mandatory 2FA** for all admin accounts
- **Peer management** - create, suspend, resume, and remove WireGuard peers
- **User management** - invite users and manage their VPN access
- **Server management** - configure and monitor WireGuard servers
- **Traffic statistics** - monitor bandwidth usage per peer and user
- **Audit logging** - immutable log of all admin actions
- **Domain blocking** - global and per-user DNS filtering via AdGuard Home
- **Self-service onboarding** - users can claim their own peer via invite link
- **Backup & restore** - one-click database backups via the admin API

## Tech Stack

- **Frontend**: React 19, TypeScript 7, Vite 8, TanStack Router/Query, Tailwind CSS 4, Recharts 3
- **Backend**: Go 1.27, chi router, wgctrl-go
- **Database**: PostgreSQL 18
- **Infrastructure**: Docker Compose, Caddy (automatic TLS), AdGuard Home (DNS filtering)

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Ubuntu 22.04+ (for native WireGuard kernel module)

### One-Command Install

```bash
curl -fsSL https://raw.githubusercontent.com/garyhooi/wireguard-console/main/install.sh | sudo bash
```

Two guaranteed-fresh alternatives (GitHub's raw CDN caches `main` for a few minutes after pushes; use these when you just pushed/need the exact latest):

```bash
# Always current (GitHub API, not CDN-cached; ~60 req/hr unauthenticated)
curl -fsSL -H "Accept: application/vnd.github.raw" \
  https://api.github.com/repos/garyhooi/wireguard-console/contents/install.sh | sudo bash

# Immutable — pinned to a specific commit
curl -fsSL https://raw.githubusercontent.com/garyhooi/wireguard-console/<COMMIT_SHA>/install.sh | sudo bash
```

The installer will:
1. Install Docker and WireGuard tools
2. Free port 53 from systemd-resolved (needed by the DNS filter) and enable IP forwarding
3. Clone the repository to `/opt/wireguard-console`
4. Generate secure secrets and prompt for your domain or public IP (`CONSOLE_DOMAIN=vpn.example.com bash install.sh` runs non-interactively)
5. Open the firewall (80/tcp, 443/tcp, 51820/udp) if ufw is active
6. Build and start all services — re-run the script any time to update

### Deploying without a domain (public IP only)

You don't need a domain. Enter the server's public IPv4 when prompted (or run `CONSOLE_DOMAIN=203.0.113.5 bash install.sh`):

- Caddy serves HTTPS using its **internal CA** — public certificate authorities can't issue certificates for bare IPs. Your browser will show a one-time self-signed certificate warning; the connection is still fully encrypted (passwords, TOTP codes, and session cookies are never sent in plaintext).
- WireGuard peer endpoints automatically use `203.0.113.5:51820`, and invite links become `https://203.0.113.5/claim/...`.
- **Want a browser-trusted certificate without buying a domain?** Use a wildcard DNS service like [sslip.io](https://sslip.io): set `CONSOLE_DOMAIN=203.0.113.5.sslip.io` (and empty `WGCONSOLE_TLS`) — sslip.io resolves to your IP, so Caddy's normal ACME flow issues a real, trusted certificate.
- IPv6-only hosts aren't supported for the console URL (use a domain or an sslip.io address there).

### Distributed nodes (one console, many regions)

Every machine running this stack is a node; the console host manages its own
interfaces automatically. To add machines in other locations: **Nodes → Add
Node** in the console, then run the one-liner it shows on that machine. The
agent installs itself (Docker + wg-helper), polls the console, applies WireGuard
interfaces locally and reports stats back — no inbound ports or SSH needed.
Then create servers with **Managed by: [node]** and everything happens
automatically on that node.

### Manual Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/garyhooi/wireguard-console.git
   cd wireguard-console
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Fill in CONSOLE_DOMAIN and generate secrets, e.g.:
   #   openssl rand -hex 32   → APP_ENCRYPTION_KEY / SESSION_SIGNING_KEY
   #   openssl rand -hex 24   → POSTGRES_PASSWORD
   ```

3. **Build and start**
   ```bash
   docker compose up -d --build
   ```

4. **Access the console**
   Navigate to `https://YOUR_DOMAIN`.

## Create the first admin account (required)

There are **no default credentials**, and the first-run setup wizard is not implemented yet — the first `super_admin` must be created manually with `gen-password` (a small Go tool in the repo), which prints the exact SQL to insert into the database:

```bash
# From a machine with Go installed (or any dev machine with the repo):
cd backend
go run ./cmd/gen-password 'YourPassw0rd!'

# No local Go? Run it in a throwaway container on the server instead:
docker run --rm -v /opt/wireguard-console/backend:/app -w /app golang:1.27 go run ./cmd/gen-password 'YourPassw0rd!'
```

The tool prints an email, the hash and a ready-to-use SQL line. Run that SQL against the database:

```bash
# On the server (replace <SQL> with the printed INSERT statement, or set the
# email/hash explicitly):
docker exec wireguard-console-postgres-1 \
  psql -U wgconsole -d wgconsole -c "<INSERT ...>"
```

Expect `INSERT 0 1`. Then log in at `https://YOUR_DOMAIN` with the email/password you chose — **2FA enrollment is mandatory** on first login (keep the backup codes).

Note: passwords must be at least 12 chars and contain upper/lowercase, a digit and a special character (enforced when the console validates passwords later).

## Upgrading

The one-command installer is idempotent — just run it again to pull the latest code and rebuild:

```bash
curl -fsSL https://raw.githubusercontent.com/garyhooi/wireguard-console/main/install.sh | sudo bash
```

**Database major upgrades** (e.g. PostgreSQL 16 → 18): existing `pg-data` volumes are NOT automatically migrated by Docker. Before upgrading, create a backup (`POST /api/backup/create`), then remove the volume (`docker compose down && docker volume rm wireguard-console_pg-data`) and let the fresh database rebuild — restore afterwards. Never point a fresh major version at old data files.

## Project Structure

```
wireguard-console/
├── install.sh         # One-command Ubuntu installer
├── docker-compose.yml # Full hosting stack (Caddy, API, wg-helper, Postgres, AdGuard)
├── .env.example       # Environment template
├── backend/           # Go API server
│   ├── cmd/api/       # Main entry point (runs migrations on boot)
│   ├── internal/      # Business logic
│   │   ├── api/       # HTTP handlers
│   │   ├── auth/      # Authentication
│   │   ├── db/        # Database models and queries
│   │   └── wg/        # WireGuard integration
│   ├── migrations/    # SQL migrations
│   └── Dockerfile
├── frontend/          # React SPA (served by Caddy + TLS in one container)
│   ├── src/
│   │   ├── routes/    # TanStack Router pages
│   │   ├── lib/       # Utilities and API client
│   │   └── components/ # Reusable UI components
│   └── Dockerfile
├── wg-helper/         # WireGuard kernel interface helper (CAP_NET_ADMIN only)
│   ├── cmd/wg-helper/
│   ├── internal/
│   └── Dockerfile
└── plan/              # Architecture documentation (build guide)
```

## Development

### Backend

```bash
cd backend
go run ./cmd/api
```

### Frontend

```bash
cd frontend
bun install
bun run dev
```

### wg-helper

```bash
cd wg-helper
go run ./cmd/wg-helper
```

## Security

- All secrets encrypted at rest with AES-256-GCM
- Argon2id password hashing
- TOTP-based 2FA for admin accounts
- `wg-helper` runs with minimal capabilities (`CAP_NET_ADMIN` + `SYS_MODULE` only)
- PostgreSQL role has restricted permissions (no DROP/TRUNCATE)
- Audit logs are append-only
- Rate limiting and account lockout on login attempts
- Security headers (CSP, HSTS, X-Frame-Options, etc.)
- CSRF protection on state-changing requests
- Password policy enforcement with HaveIBeenPwned check
- `scripts/scan-vulnerabilities.sh` for dependency vulnerability scanning

## Backup & Restore

Backups are created inside the `api` container (which includes `pg_dump`) and stored on a persistent Docker volume at `/var/backups/wgconsole`. Super-admin only.

```bash
# Create backup
curl -X POST https://your-domain/api/backup/create \
  -H "Authorization: YOUR_TOKEN"

# List backups
curl https://your-domain/api/backup/list \
  -H "Authorization: YOUR_TOKEN"

# Restore a backup
curl -X POST https://your-domain/api/backup/restore \
  -H "Authorization: YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filename": "wgconsole_backup_20260903_120000.sql.gz"}'

# Or restore manually
gunzip -c wgconsole_backup_*.sql.gz | \
  docker exec -i wireguard-console-postgres-1 psql -U wgconsole -d wgconsole
```

## License

Choose your license: MIT, Apache-2.0, or AGPL-3.0 (see `plan/WIREGUARD CONSOLE BUILD GUIDE.md` for guidance).

## Documentation

See `plan/WIREGUARD CONSOLE BUILD GUIDE.md` for detailed architecture, data model, API reference, and deployment guide.
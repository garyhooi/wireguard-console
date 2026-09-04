# WireGuard Console

A self-hosted, production-grade web console for issuing, monitoring, and revoking company WireGuard VPN access.

## Features

- **Two account types, clearly separated**: *Admins* (console operators —
  super_admin / admin / auditor, invited with emailed credentials) and
  *VPN Users* (people who receive tunnel access via a self-service claim link)
- **Mandatory 2FA** for all admin accounts (enroll/disable from Profile)
- **Peer management** — create, suspend, resume, remove; each peer shows its
  owning VPN user; optional e-mail of the ready `wg-quick` config
- **Profile page** — change password, manage 2FA, see your role
- **Distributed nodes** — one console manages many machines across regions
  (each node runs wg-helper in agent mode; setup is a one-liner)
- **Domain blocking** — global and per-user DNS filtering via AdGuard Home,
  with an editable branded block page (Caddy catch-all)
- **Email templates** — editable invite / peer-config / admin-invite emails
  (CMS in Configuration), sent when SMTP is configured
- **Traffic usage reports** — per peer or per VPN user within any date range,
  with CSV export (Statistics → Usage report)
- **Filters everywhere** — status tabs + search on VPN Users and Admins
- **Audit logging** — immutable log of all admin actions
- **Backup & restore** — one-click database backups via the admin API
- **Automated tests** — backend unit + real E2E against Postgres 18,
  frontend component tests, CI workflow (`scripts/test.sh`)

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
1. Install Docker + Compose and WireGuard tools
2. Free port 53 from systemd-resolved (needed by the DNS filter) and enable IP forwarding
3. Clone the repository to `/opt/wireguard-console`
4. Generate secure secrets and prompt for your domain or public IP (`CONSOLE_DOMAIN=vpn.example.com bash install.sh` runs non-interactively)
5. Open the firewall (80/tcp, 443/tcp, 51820/udp) if ufw is active
6. Build and start all services, **provision AdGuard Home** (write its config:
   matching admin password, DNS bound to the tunnel gateway, blocked domains
   resolving to the branded block page)
7. **Auto-create the first `super_admin`** on a fresh database and **print its
   credentials in the install output** (email + one-time password right in
   the summary — no separate `docker logs` needed)
8. Re-run the script any time to update (existing admins/data are kept)

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

### Domain blocking & the block page

DNS filtering runs through the built-in **AdGuard Home** and is set up
automatically by the installer. Peers use the tunnel gateway
(`DNS = 10.8.0.1`) as their resolver, so every lookup passes the filter:

- Add rules under **Security → Domain Rules** (`google.com` — global, or per
  VPN user). The console pushes them to AdGuard automatically.
- Blocked domains resolve to `10.8.0.1`, where Caddy serves the branded
  **"Access blocked — VPN policy"** page over HTTP.
- Re-run `sudo bash configure-adguard.sh` any time to re-provision AdGuard
  (it writes `AdGuardHome.yaml` directly into the config volume — never
  depends on the interactive first-run wizard). `--diag` prints the current
  state for troubleshooting.

**Note:** browsers force HTTPS on most sites, so `https://blocked.example`
shows a connection error rather than the page — the DNS block still stops the
connection (that is the protection). The branded page renders for HTTP
requests and can be customized by editing `frontend/public/blocked.html`.

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

## First admin account (auto-created)

On a **fresh** install the installer auto-creates the first `super_admin` and
prints its credentials at the end of the install output:

```text
 First super_admin account (auto-created on first boot):
   Email:    admin@company.com
   Password: Wg3756ad9880d4141!

 Log in at the console URL above, then change this password in Profile
 and enroll 2FA immediately. This is the only time these credentials
 are shown.
```

The account is bootstrapped by the API on its first boot (only when no admin
exists yet — no manual SQL). Log in at `https://YOUR_DOMAIN`, change the
password in **Profile**, and enroll 2FA immediately (mandatory; keep the
backup codes). If you missed the summary output, the same credentials are in
the generated `.env` (`ADMIN_EMAIL` / `ADMIN_PASSWORD`) on the server.

Following the **manual setup** steps instead (no installer)? The API then uses
whatever `ADMIN_EMAIL`/`ADMIN_PASSWORD` your `.env` has; if the password is
empty it generates a random one and prints it to the api container logs —
fetch it with:

```bash
docker logs wireguard-console-api-1 | grep -A1 'Email:\|Password:'
```

Prefer fixed credentials? Set them before running the installer (they are used
only when no admin exists yet, and are written into `.env` so upgrades keep
them):

```bash
ADMIN_EMAIL=ops@company.com ADMIN_PASSWORD='Str0ngPassw0rd!' bash install.sh
```

Passwords must be ≥ 12 chars with upper/lowercase, a digit and a special character. To add more operators afterwards, use **System → Admins → Invite Admin** (they receive emailed temporary credentials) — and manage VPN users under **Directory → VPN Users**.

## Upgrading

The one-command installer is idempotent — just run it again to pull the latest code and rebuild:

```bash
curl -fsSL https://raw.githubusercontent.com/garyhooi/wireguard-console/main/install.sh | sudo bash
```

## Project Structure

```
wireguard-console/
├── install.sh         # One-command Ubuntu installer (auto: AGH + first admin)
├── configure-adguard.sh  # (Re)provision AdGuard Home deterministically
├── docker-compose.yml # Full stack (Caddy+SPA, API, wg-helper, Postgres 18, AdGuard, block page)
├── .env.example       # Environment template
├── backend/           # Go API server
│   ├── cmd/api/       # Main entry point (runs migrations on boot)
│   ├── internal/      # Business logic
│   │   ├── api/       # HTTP handlers
│   │   ├── auth/      # Authentication
│   │   ├── db/        # Database models and queries
│   │   ├── email/     # Mail queue + worker
│   │   ├── adguard/   # AdGuard Home /control API client
│   │   └── worker/    # Traffic sampler, rollup, mail worker
│   ├── cmd/api/       # API entrypoint (migrations + admin bootstrap)
│   ├── cmd/aghenc/    # bcrypt helper for the AdGuard config
│   ├── migrations/    # SQL migrations (001-008)
│   ├── e2e/           # End-to-end tests (boot the real API + Postgres)
│   └── Dockerfile
├── frontend/          # React SPA (served by Caddy + TLS in one container)
│   ├── src/
│   │   ├── routes/    # TanStack Router pages
│   │   ├── lib/       # Utilities + UI primitives (ui.tsx)
│   │   └── styles/    # Design tokens (Geist, dark ops theme)
│   └── Dockerfile
├── wg-helper/         # WireGuard kernel interface helper (CAP_NET_ADMIN only)
│   ├── cmd/wg-helper/ # Local socket OR distributed-node agent mode
│   ├── internal/
│   └── Dockerfile
├── scripts/test.sh    # Run the full test suite locally
├── .github/workflows/ci.yml  # Backend unit + E2E, frontend, shell checks
└── plan/              # Architecture documentation (build guide)
```

## Development

### Backend

```bash
cd backend
# Requires DATABASE_URL, WG_HELPER_SOCKET, APP_ENCRYPTION_KEY,
# SESSION_SIGNING_KEY and a reachable Postgres — see docker-compose.yml.
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

## Testing

`scripts/test.sh` runs the whole suite locally — backend unit tests, a real
**E2E suite** (boots the API binary against a throwaway PostgreSQL 18, then
walks the contracts: login, server/peer provisioning, config download, SMTP,
claims, admin/user lifecycle, traffic usage, node agent), frontend component
tests, and a production build:

```bash
scripts/test.sh          # uses docker (or Apple container) Postgres
```

CI (`.github/workflows/ci.yml`) runs the same four jobs on every push:
backend unit+vet, backend E2E against a `postgres:18` service, frontend
tests + build, and installer-script syntax checks. (Pushing the workflow
file requires a GitHub token with the `workflow` scope.)

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

Backups are created inside the `api` container (which includes `pg_dump`) and stored on a persistent Docker volume at `/var/backups/wgconsole`.

**From the console UI:** open **System → Backups** to list saved backups, create a new one with one click, or restore any listed backup (the UI asks for confirmation first — restoring replaces the current database). Admins with the `admin` or `super_admin` role can use it.

The same operations are available over the API (useful for scripting / off-server backup copies). Authenticate with your admin session token (the one the UI stores in `localStorage` after login — see *First admin account*):

```bash
# Create backup
curl -X POST https://your-domain/api/backup/create \
  -H "Authorization: <admin-session-token>"

# List backups
curl https://your-domain/api/backup/list \
  -H "Authorization: <admin-session-token>"

# Restore a backup
curl -X POST https://your-domain/api/backup/restore \
  -H "Authorization: <admin-session-token>" \
  -H "Content-Type: application/json" \
  -d '{"filename": "wgconsole_backup_20260903_120000.sql.gz"}'

# Or restore manually (shell on the server)
gunzip -c wgconsole_backup_*.sql.gz | \
  docker exec -i wireguard-console-postgres-1 psql -U wgconsole -d wgconsole
```

Backups only live on the console's Docker volume — copy them off the server regularly for disaster recovery.

## License

[MIT](LICENSE) — © 2026 Gary Hooi. See the `LICENSE` file for the full text.

## Documentation

See `plan/WIREGUARD CONSOLE BUILD GUIDE.md` for detailed architecture, data model, API reference, and deployment guide.
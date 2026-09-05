# WireGuard Console

A self-hosted, production-grade web console for issuing, monitoring, and revoking company WireGuard VPN access.

## Features

- **Two account types, clearly separated**: *Admins* (console operators —
  super_admin / admin / auditor, invited with emailed credentials) and
  *VPN Users* (people who receive tunnel access via a self-service claim link)
- **Mandatory 2FA** for all admin accounts (enroll/disable from Profile);
  a super admin can **reset a lost 2FA** for another admin, and privileged
  helpdesk actions (password/email/role changes, 2FA resets) require the
  acting admin's own 2FA code
- **Peer management** — create, suspend, resume, remove; each peer shows its
  owning VPN user; optional e-mail of the ready `wg-quick` config
- **Profile page** — change password, manage 2FA, see your role
- **Distributed nodes** — one console manages many machines across regions
  (each node runs wg-helper in agent mode; setup is a one-liner)
- **Domain blocking** — global and per-user DNS filtering via AdGuard Home,
  with an editable branded block page (Caddy catch-all)
- **Web Activity** — per-VPN-user / per-peer browsing history imported from
  AdGuard's query log, with allowed/blocked flags, domain search + date range,
  CSV export, and top-10 domain panels (allowed + blocked attempts) on the
  Statistics page; super admins can purge history, and a nightly worker keeps
  only the retention window (default 30 days) to bound storage
- **Email templates** — editable invite / peer-config / admin-invite emails
  (CMS in Configuration), sent when SMTP is configured
- **Traffic usage reports** — per peer or per VPN user within any date range,
  with CSV export (Statistics → Usage report)
- **Filters everywhere** — status tabs + search on VPN Users and Admins
- **Audit logging** — immutable log of all admin actions
- **Backup & restore** — one-click database backups via the admin API; download
  backups off-server and restore from an uploaded file (2FA-gated)
- **Automated tests** — backend unit + real E2E against Postgres 18,
  frontend component tests, CI workflow (`scripts/test.sh`)

## Screens

A small deployment, seeded with a few VPN users, peers, servers and a day
of traffic so the charts and reports have real data to show.

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/demo/dashboard.png" alt="Dashboard" width="100%" />
      <br /><em>Dashboard — live KPIs and recent peers</em>
    </td>
    <td align="center" width="50%">
      <img src="docs/demo/statistics.png" alt="Statistics" width="100%" />
      <br /><em>Statistics — traffic chart, top peers and usage report</em>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/demo/peers.png" alt="Peers" width="100%" />
      <br /><em>Peers — active/suspended devices, config &amp; QR actions</em>
    </td>
    <td align="center" width="50%">
      <img src="docs/demo/users.png" alt="VPN Users" width="100%" />
      <br /><em>VPN Users — status tabs, search and invite</em>
    </td>
  </tr>
</table>

**Try it yourself** — follow [Quick Start](#quick-start), then use the demo
seed (dev only) to load believable data in one command:

```bash
PGPASSWORD=<your-password> psql -h localhost -U wgconsole -d wgconsole \
  -f scripts/demo-seed.sql
```

The seed is idempotent and safe to re-run against a local database. It does
not touch the bootstrap `super_admin`.

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
- Blocked domains resolve to the tunnel gateway, where Caddy serves the
  branded **"Access blocked — VPN policy"** page — over both HTTP **and**
  HTTPS (HTTPS uses an internal certificate, so the browser shows a one-time
  self-signed warning before the page).
- Re-run `sudo bash configure-adguard.sh` any time to re-provision AdGuard
  (it writes `AdGuardHome.yaml` directly into the config volume — never
  depends on the interactive first-run wizard). `--diag` prints the current
  state for troubleshooting.
- The console re-syncs the rules into AdGuard automatically on rule
  changes, at startup, and every 5 minutes, and the **Security → Domain
  Rules** page shows live AdGuard health (reachable / synced / missing
  rules) so a silent failure is visible instead of a mystery.

#### Web Activity (what each user browsed)

AdGuard's query log is also the source for **Monitoring → Web Activity**:
a worker imports every DNS query made by a tunnel peer into the console DB
every 30 seconds, tagged with the owning VPN user and peer, the domain, and
whether AdGuard blocked it (`FilteredBlackList`, parental, blocked service,
…). You can:

- Browse activity **by VPN user or by peer**, filtered by date range,
  status (all / allowed / blocked) and a domain search, with CSV export.
- See **Statistics → Top domains browsed** and **Top blocked-domain
  attempts** (the 10 most-resolved domains and the 10 most-refused
  domains across all users, last 7 days).
- Keep storage bounded: the worker purges records older than
  `BROWSE_RETENTION_DAYS` (default 30) every night, and **super admins**
  can purge immediately from the Web Activity page's Housekeeping panel.

Only *domain names* are visible — WireGuard encrypts full URLs and page
content, so the console never sees paths, queries, or page text.

**Note:** a handful of HSTS-preloaded domains (e.g. `google.com`) make the
browser refuse to proceed past the self-signed warning entirely — the
connection is still blocked (that is the protection), it just won't render
the branded page. The page can be customized by editing
`frontend/public/blocked.html`.

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
│   │   └── worker/    # Traffic sampler, rollup, mail, browse (web-activity import)
│   ├── cmd/api/       # API entrypoint (migrations + admin bootstrap)
│   ├── cmd/aghenc/    # bcrypt helper for the AdGuard config
│   ├── migrations/    # SQL migrations (001-011)
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
- **2FA step-up on privileged actions** — changing an admin's email/role/status, resetting an admin's password or 2FA, and downloading/restoring/deleting a backup all require the *acting* admin's current 2FA code (a stolen session alone is not enough)
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

**From the console UI:** open **System → Backups** to list saved backups, create a new one with one click, **download** any backup (to keep an off-server copy), **restore** a listed backup, or **restore from an uploaded `.sql.gz` file**. Every destructive/off-server action (download, restore, delete, upload-restore) asks for your own 2FA code first — restoring replaces the current database.

The same operations are available over the API (useful for scripting / off-server backup copies). Authenticate with your admin session token (the one the UI stores in `localStorage` after login — see *First admin account*). Actions that read or replace data require a current 2FA code in the body (`code`):

```bash
# Create backup (no 2FA needed — making a backup is safe)
curl -X POST https://your-domain/api/backup/create \
  -H "Authorization: <admin-session-token>"

# List backups
curl https://your-domain/api/backup/list \
  -H "Authorization: <admin-session-token>"

# Download a backup (needs 2FA)
curl -X POST https://your-domain/api/backup/download \
  -H "Authorization: <admin-session-token>" \
  -H "Content-Type: application/json" \
  -d '{"filename": "wgconsole_backup_20260903_120000.sql.gz", "code": "<your-2fa-code>"}' \
  -o backup.sql.gz

# Restore a backup (needs 2FA)
curl -X POST https://your-domain/api/backup/restore \
  -H "Authorization: <admin-session-token>" \
  -H "Content-Type: application/json" \
  -d '{"filename": "wgconsole_backup_20260903_120000.sql.gz", "code": "<your-2fa-code>"}'

# Or restore manually (shell on the server)
gunzip -c wgconsole_backup_*.sql.gz | \
  docker exec -i wireguard-console-postgres-1 psql -U wgconsole -d wgconsole
```

Backups only live on the console's Docker volume — copy them off the server regularly for disaster recovery (use the Download button or the API above).

## License

Licensed under the [Apache License, Version 2.0](LICENSE) — © 2026 Gary Hooi. See the `LICENSE` file for the full text.

## Documentation

See `plan/WIREGUARD CONSOLE BUILD GUIDE.md` for detailed architecture, data model, API reference, and deployment guide.
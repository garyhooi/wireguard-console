# WireGuard Console landing page

A Next.js 16 marketing site and interactive console demo for [WireGuard Console](../README.md).

## Run it

```bash
pnpm install
pnpm dev        # http://localhost:3000
```

Production:

```bash
NEXT_PUBLIC_SITE_URL=https://your-domain.example pnpm build
pnpm start
```

## Environment

| Variable | Purpose | Default |
| --- | --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Canonical origin used by metadata, OG images, sitemap and robots | `https://wireguard-console.g-studio.dev` |
| `NEXT_PUBLIC_CONSOLE_URL` | Optional link to a real console, shown in the demo sidebar footer | unset |
| `NEXT_OUTPUT` | `export` for Cloudflare Pages, `standalone` for Docker | unset |
| `GOOGLE_SITE_VERIFICATION` | Google Search Console verification token | unset |

Set `NEXT_PUBLIC_SITE_URL` before `pnpm build` in production. The canonical URL, sitemap and social image URLs are baked at build time. Next.js needs the build-time value, so do not pass it only to the runtime container.

## Routes

- `/` - landing page. Indexable, with SoftwareApplication, WebSite, FAQPage and HowTo JSON-LD.
- `/demo` - interactive console demo. Starts at the sign-in screen; any email/password enters the sample console. `noindex, follow`, excluded from the sitemap.
- `/sitemap.xml`, `/robots.txt`, `/manifest.webmanifest`
- `/opengraph-image` - 1200x630 social card generated with `next/og`
- `/icon.svg`, `/apple-icon`

The demo mirrors the signed-in console: the same ShieldLock mark, zinc/teal palette, 240px sidebar, 56px top bar, table styles and centered dialogs. It includes the full navigation: Dashboard, Statistics, Server Monitoring, Web Activity, Audit Log, Servers, Peers, Nodes, VPN Users, Departments, Admins, Domain Blocking, IP Blocking, Backups, Configuration and Profile. The Backups screen shows encrypted/plain protection, restore verification, S3 copies, automatic scheduling and retention. Sign out returns to the login screen.

## SEO notes

- One H1 with the primary keyword, descriptive H2/H3 hierarchy, and internal links.
- Canonical URL, Open Graph and Twitter cards, image alt text, icons, manifest and theme color.
- FAQ content on the page matches the `FAQPage` schema exactly.
- The demo is intentionally excluded from indexing and the sitemap.
- Screenshots are real console screenshots from `../docs/demo`, served through `next/image` with AVIF/WebP.
- The topology canvas pauses offscreen and for `prefers-reduced-motion`, which keeps the page interactive without stealing frames during scroll.

## Deploy to Cloudflare Pages

The site can be exported as static assets and uploaded to Cloudflare Pages. Build with the production origin baked in:

```bash
NEXT_OUTPUT=export NEXT_PUBLIC_SITE_URL=https://wireguard-console.g-studio.dev pnpm build
```

Upload the contents of `out/` as a Pages project, then attach `wireguard-console.g-studio.dev` under **Custom domains**. Security headers and the OG image content type are supplied by `public/_headers`; `next.config.ts` disables the server-only `headers()` hook when `NEXT_OUTPUT=export`.

## Deploy with Docker

```bash
docker build \
  --build-arg NEXT_PUBLIC_SITE_URL=https://your-domain.example \
  -t wireguard-console-landing .
docker run --rm -p 3000:3000 wireguard-console-landing
```

The image uses Next.js standalone output, runs as a non-root user and serves on port 3000. Put it behind Caddy, nginx or a cloud load balancer that terminates TLS.

## Project structure

```
src/app/               App Router routes, metadata, OG images, sitemap and robots
src/components/        Marketing sections, topology canvas and console demo
src/components/demo/   Demo state, views and dialogs
src/lib/content.ts     Marketing copy, FAQs, features and steps
src/lib/site.ts        Site URL, repo links and navigation
src/assets/screens/    Real console screenshots
```

The demo starts at the same sign-in screen as the console. Any email and password, or the passkey button, enters the sample console. It is local-only: sample data, settings and generated configs never call an API or touch a WireGuard interface.
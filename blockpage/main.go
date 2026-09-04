// blockpage serves the branded "blocked by VPN policy" page.
//
// AdGuard Home is configured (via the console) to resolve blocked domains
// to this server's IP (the WireGuard tunnel gateway). When a peer's browser
// hits http://<blocked-domain>/ it reaches this listener and gets the page.
package main

import (
	"log"
	"net/http"
	"os"
	"strings"
)

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blocked by VPN policy</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    min-height: 100dvh; display: flex; align-items: center; justify-content: center;
    background: radial-gradient(1200px 600px at 20% -10%, #0f172a, #09090b 60%);
    color: #e4e4e7; padding: 24px;
  }
  .card { max-width: 460px; width: 100%; text-align: center; }
  .badge {
    display: inline-flex; align-items: center; gap: 8px;
    border: 1px solid #14b8a6; color: #2dd4bf;
    background: #14b8a610; border-radius: 999px;
    padding: 6px 14px; font-size: 13px; font-weight: 600; letter-spacing: .4px;
  }
  .badge .dot { width: 8px; height: 8px; border-radius: 50%; background: #14b8a6; }
  h1 { margin: 20px 0 10px; font-size: 26px; font-weight: 700; color: #fff; }
  .domain {
    display: inline-block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px; color: #a1a1aa; background: #18181b; border: 1px solid #27272a;
    padding: 4px 10px; border-radius: 6px; margin-bottom: 16px; max-width: 100%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  p.desc { color: #a1a1aa; font-size: 15px; line-height: 1.6; }
  .sep { height: 1px; background: #27272a; margin: 22px 0; }
  .foot { color: #52525b; font-size: 12px; }
</style>
</head>
<body>
  <div class="card">
    <span class="badge"><span class="dot"></span> VPN Policy</span>
    <h1>Access blocked</h1>
    <div class="domain">%DOMAIN%</div>
    <p class="desc">This site is blocked by your organization's VPN policy.
      If you believe this is a mistake, contact your network administrator.</p>
    <div class="sep"></div>
    <p class="foot">Blocked by the WireGuard Console domain filter</p>
  </div>
</body>
</html>`

func handler(w http.ResponseWriter, r *http.Request) {
	domain := strings.Split(r.Host, ":")[0]
	body := strings.ReplaceAll(page, "%DOMAIN%", domain)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(body))
}

func main() {
	addr := os.Getenv("BLOCKPAGE_ADDR")
	if addr == "" {
		addr = ":80"
	}
	http.HandleFunc("/", handler)
	log.Printf("blockpage listening on %s", addr)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatal(err)
	}
}

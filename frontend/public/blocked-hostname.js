// Blocked-page hostname display. Kept as an external file (not inline) so
// the block page can be served under a strict Content-Security-Policy
// (script-src 'self') with no 'unsafe-inline'. Only ever assigns the current
// hostname into a text node — no user-controlled markup.
document.getElementById('d').textContent = location.hostname || location.host;

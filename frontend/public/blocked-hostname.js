// Blocked-page hostname display. Kept as an external file (not inline) so
// the block page can be served under a strict Content-Security-Policy
// (script-src 'self') with no 'unsafe-inline'. Only ever assigns the current
// hostname into a text node — no user-controlled markup.
var host = location.hostname || location.host;
var domain = document.getElementById('d');
if (domain) domain.textContent = host;
var introDomain = document.getElementById('di');
if (introDomain) introDomain.textContent = host;

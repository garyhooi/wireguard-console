export const metrics = [
  { value: "15s", label: "node poll interval" },
  { value: "0", label: "inbound management ports" },
  { value: "~2 min", label: "to add a node" },
  { value: "1", label: "console for every exit" },
] as const;

export const stack = [
  "WireGuard",
  "Docker",
  "AdGuard Home",
  "PostgreSQL",
  "Caddy",
  "Apache 2.0",
] as const;

export const chapters = [
  {
    id: "join",
    label: "Node joins",
    title: "A new exit joins with one command.",
    body: "Create the node, copy its token and run the installer on the host. The agent dials out, picks up its WireGuard config and keeps it applied.",
    points: ["Outbound HTTPS only", "15s poll", "Reapplies after reboot"],
    command:
      "curl -fsSL https://raw.githubusercontent.com/garyhooi/wireguard-console/main/node-install.sh \\\n  | sudo bash -s -- <TOKEN> https://console.example.com <NODE_ID>",
  },
  {
    id: "peers",
    label: "Peers connect",
    title: "Issue a peer on the exit you choose.",
    body: "Keys and tunnel IPs are generated in the console. Hand the config to a person or device and traffic leaves through that region. Revoke it from the same table.",
    points: ["Per-device keys", "Exit by region", "Instant revoke"],
    command:
      "[Interface]\nPrivateKey = <generated>\nAddress = 10.9.0.14/32\nDNS = 10.9.0.1\n\n[Peer]\nEndpoint = 203.0.113.10:51820\nAllowedIPs = 0.0.0.0/0, ::/0",
  },
  {
    id: "cross-region",
    label: "Cross-region",
    title: "Add a node without adding a control plane.",
    body: "Frankfurt, Singapore, San Francisco, Sydney. Every exit is a spoke on the same console, with its own subnet and its own local WireGuard traffic.",
    points: ["One admin surface", "Unique subnet per exit", "No extra console"],
    command:
      "# One console owns the control plane\nconsole  ams-1   10.8.0.0/24\nexit     fra-1   10.9.0.0/24\nexit     sgp-1   10.10.0.0/24\nexit     sfo-1   10.11.0.0/24",
  },
] as const;

export const consoleFeatures = [
  {
    title: "Peers and people",
    body: "Issue, suspend and revoke devices. Public keys and tunnel IPs are generated for you.",
    icon: "devices",
  },
  {
    title: "Handshakes and status",
    body: "See which peers are up and when they last handshook. Traffic charts cover the console host.",
    icon: "pulse",
  },
  {
    title: "DNS filtering",
    body: "Block domain groups globally, per user or per department through AdGuard, with a branded block page.",
    icon: "shield",
  },
  {
    title: "IP blocking",
    body: "Drop IPv4 and IPv6 addresses or ranges before NAT, globally or per user, with reusable groups.",
    icon: "ban",
  },
  {
    title: "Activity and audit",
    body: "Review web activity on the console exit, export usage as CSV and follow every admin action.",
    icon: "chart",
  },
] as const;

export const securityPoints = [
  {
    title: "Mandatory second factor",
    body: "Every admin enrolls a passkey or an authenticator app before the first session is issued.",
  },
  {
    title: "Passwordless sign-in",
    body: "A saved passkey can replace the password entirely, with Face ID, Touch ID or a security key.",
  },
  {
    title: "Step-up for destructive work",
    body: "Restores and other irreversible actions ask for MFA again, even inside a signed-in session.",
  },
  {
    title: "Recovery that stays usable",
    body: "Single-use recovery codes, plus a super admin reset path when a factor is lost.",
  },
] as const;

export const operations = [
  {
    key: "dns",
    title: "Filter where the tunnel ends",
    body: "AdGuard rules apply to the console exit. Use reusable domain groups, scope them to a department and point peers at it.",
    kind: "large",
  },
  {
    key: "ip",
    title: "Drop ranges before NAT",
    body: "IPv4 and IPv6 rules are enforced server-side, before traffic is forwarded. Block globally or for one peer.",
    kind: "large",
  },
  {
    key: "agent",
    title: "Agents that reapply",
    body: "After a reboot, the node agent re-applies its interfaces on the next poll. No cron scripts to babysit.",
    kind: "small",
  },
  {
    key: "backup",
    title: "Backups gated by MFA",
    body: "Create, download and restore from the console. Destructive restores require a fresh factor.",
    kind: "small",
  },
  {
    key: "license",
    title: "Apache 2.0, no seats",
    body: "Self-host the whole stack. No hosted control plane and no per-admin licence.",
    kind: "small",
  },
] as const;

export const deploySteps = [
  {
    title: "Install the console",
    body: "Ubuntu 22.04+ or Debian 12+. The installer adds Docker, starts the stack and prints your first admin password.",
  },
  {
    title: "Join the node",
    body: "Create a node in the console, run its join command and open the WireGuard UDP port on that host.",
  },
  {
    title: "Create a server",
    body: "Give the exit a public endpoint, a subnet that no other node uses, and DNS servers for peers.",
  },
  {
    title: "Issue a peer",
    body: "Assign a person or device to that exit, deliver the config and watch the first handshake.",
  },
] as const;

export const faqs = [
  {
    q: "Is WireGuard Console a hosted VPN service?",
    a: "No. It is a self-hosted web console and a node agent for the WireGuard servers you run. The stack is Docker, PostgreSQL and Caddy, and the code is Apache 2.0.",
  },
  {
    q: "Which operating systems are supported?",
    a: "Ubuntu 22.04+ and Debian 12+ are supported on the console host and on exit nodes. The installer handles Docker, WireGuard and systemd on either distribution.",
  },
  {
    q: "Do remote nodes need inbound management ports?",
    a: "No. The node installer needs one SSH session. After that the agent dials out to the console over HTTPS every 15 seconds, so only the WireGuard UDP port has to be public.",
  },
  {
    q: "Do I need a domain to install it?",
    a: "You can install on a public IP and let Caddy use its internal CA, with a one-time browser warning. Passkeys need a hostname, so use a domain if you want passwordless sign-in.",
  },
  {
    q: "How long does a new node take?",
    a: "Create the node in the console, run the join command on an Ubuntu 22.04+ or Debian 12+ host, then wait about 30 seconds for its first poll. The README estimates roughly two minutes including the install.",
  },
  {
    q: "Do remote nodes report traffic and browsing?",
    a: "Not today. Traffic charts and web activity cover the console host's AdGuard instance. Node agents apply WireGuard interfaces and keep them applied after a reboot.",
  },
  {
    q: "What runs on each machine?",
    a: "The main host runs the console stack, Caddy, PostgreSQL and AdGuard Home. Each exit runs Docker, the node agent and WireGuard. DNS servers are set per VPN server, so peers never default to an empty resolver.",
  },
  {
    q: "How do backup and restore work?",
    a: "System, then Backups, creates and downloads a backup. A restore requires MFA confirmation. Backups live on the console's Docker volume, so download a copy off the server.",
  },
  {
    q: "What is the licence?",
    a: "Apache 2.0. You can run it internally, modify it or fork it without a per-admin fee.",
  },
] as const;
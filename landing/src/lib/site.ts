const rawUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://wireguard-console.g-studio.dev";

export const siteConfig = {
  name: "WireGuard Console",
  url: rawUrl.replace(/\/$/, ""),
  repo: "https://github.com/garyhooi/wireguard-console",
  docs: "https://github.com/garyhooi/wireguard-console#readme",
  license: "https://github.com/garyhooi/wireguard-console/blob/main/LICENSE",
  installCommand:
    "curl -fsSL https://raw.githubusercontent.com/garyhooi/wireguard-console/main/install.sh | sudo bash",
  description:
    "Self-hosted WireGuard console to issue, monitor and revoke VPN access across regions. Nodes join in minutes, admins stay behind MFA.",
  keywords: [
    "WireGuard",
    "WireGuard console",
    "self-hosted VPN",
    "WireGuard VPN management",
    "VPN access control",
    "WireGuard dashboard",
    "multi-region VPN",
    "AdGuard DNS filtering",
    "WireGuard mesh",
    "zero trust VPN",
  ],
  consoleUrl: process.env.NEXT_PUBLIC_CONSOLE_URL ?? "",
} as const;

export const navItems = [
  { href: "/#console", label: "Console" },
  { href: "/#topology", label: "Topology" },
  { href: "/#security", label: "Security" },
  { href: "/#deploy", label: "Deploy" },
] as const;
export type RegionStatus = "ok" | "joining";

export type Region = {
  id: string;
  city: string;
  code: string;
  zone: string;
  status: RegionStatus;
  lastPoll: string;
  servers: number;
  endpoint: string;
  subnet: string;
  dns: string;
  serverPublicKey: string;
};

export type PeerKind = "laptop" | "phone" | "tablet";
export type PeerStatus = "active" | "suspended";

export type Peer = {
  id: string;
  name: string;
  device: string;
  kind: PeerKind;
  department: string;
  regionId: string;
  ip: string;
  status: PeerStatus;
  lastHandshake: string;
  createdAt: string;
  publicKey: string;
};

export type ActivityKind = "peer" | "rule" | "node" | "backup" | "auth";

export type Activity = {
  id: string;
  kind: ActivityKind;
  action: string;
  detail: string;
  at: string;
  actor: string;
};

export type RuleGroup = {
  id: string;
  label: string;
  domains: number;
  enabled: boolean;
};

export type IpBlock = {
  id: string;
  cidr: string;
  scope: string;
  addedAt: string;
};

export type ToastTone = "success" | "info" | "danger";

export type Toast = {
  id: number;
  message: string;
  tone: ToastTone;
};

export const departments = [
  "Engineering",
  "Design",
  "Sales",
  "Finance",
  "Support",
] as const;

export const seedRegions: Region[] = [
  {
    id: "fra",
    city: "Frankfurt",
    code: "fra-1",
    zone: "EU",
    status: "ok",
    lastPoll: "6s ago",
    servers: 1,
    endpoint: "203.0.113.10:51820",
    subnet: "10.9.0.0/24",
    dns: "10.9.0.1",
    serverPublicKey: "5XSFJjZxQ+1L0je/AbQZ2wJIISMUdc7WP62DcsXjfAI=",
  },
  {
    id: "sgp",
    city: "Singapore",
    code: "sgp-1",
    zone: "APAC",
    status: "ok",
    lastPoll: "11s ago",
    servers: 1,
    endpoint: "203.0.113.24:51820",
    subnet: "10.10.0.0/24",
    dns: "10.10.0.1",
    serverPublicKey: "bvSYHnGFn25/O0Xefu8WE1G6FrPPKyw4WN7p6t9+TFw=",
  },
  {
    id: "sfo",
    city: "San Francisco",
    code: "sfo-1",
    zone: "US",
    status: "ok",
    lastPoll: "4s ago",
    servers: 1,
    endpoint: "203.0.113.41:51820",
    subnet: "10.11.0.0/24",
    dns: "10.11.0.1",
    serverPublicKey: "uufzox7T6Uq+vmslDLKqtDHF+JhM85QdVVwte9Ooyfw=",
  },
];

export const seedPeers: Peer[] = [
  {
    id: "mira",
    name: "Mira Chen",
    device: "MacBook Pro",
    kind: "laptop",
    department: "Engineering",
    regionId: "fra",
    ip: "10.9.0.14",
    status: "active",
    lastHandshake: "12s ago",
    createdAt: "2026-09-18",
    publicKey: "BkRUoht+ruXAWbjFxG+G37QCRj4z4cduavJAwCH+G4E=",
  },
  {
    id: "tomasz",
    name: "Tomasz Nowak",
    device: "Pixel 9",
    kind: "phone",
    department: "Engineering",
    regionId: "fra",
    ip: "10.9.0.21",
    status: "active",
    lastHandshake: "1m ago",
    createdAt: "2026-10-02",
    publicKey: "9Jnetq8R6E7yDOQsf8BHn6Eu7VcxYCiHCixJ+DNYfA0=",
  },
  {
    id: "aisha",
    name: "Aisha Rahman",
    device: "iPhone 16",
    kind: "phone",
    department: "Design",
    regionId: "sgp",
    ip: "10.10.0.8",
    status: "active",
    lastHandshake: "8s ago",
    createdAt: "2026-10-11",
    publicKey: "XVDdhtP8TaVmowWLfPNr4/LZT6ZlGsUEIApPjXTJWaY=",
  },
  {
    id: "lucas",
    name: "Lucas Ferreira",
    device: "ThinkPad X1",
    kind: "laptop",
    department: "Engineering",
    regionId: "sgp",
    ip: "10.10.0.19",
    status: "active",
    lastHandshake: "3m ago",
    createdAt: "2026-08-30",
    publicKey: "Bg2PJrmvEKJd1k+AM9LYhzM9dojWuB4j/Muz7jW50S0=",
  },
  {
    id: "hana",
    name: "Hana Sato",
    device: "iPad Air",
    kind: "tablet",
    department: "Finance",
    regionId: "sfo",
    ip: "10.11.0.6",
    status: "suspended",
    lastHandshake: "2d ago",
    createdAt: "2026-07-04",
    publicKey: "+6Se/CAxu4wN5dH4dAUncTz5DOA6eFRsY9lFoabkduU=",
  },
  {
    id: "noah",
    name: "Noah Williams",
    device: "MacBook Air",
    kind: "laptop",
    department: "Sales",
    regionId: "sfo",
    ip: "10.11.0.11",
    status: "active",
    lastHandshake: "45s ago",
    createdAt: "2026-10-21",
    publicKey: "VDHCpdy7x03eX4A2H9IvBXu/x9UBMRnoyYV0DyiCLno=",
  },
  {
    id: "priya",
    name: "Priya Nair",
    device: "Galaxy S25",
    kind: "phone",
    department: "Support",
    regionId: "sgp",
    ip: "10.10.0.27",
    status: "active",
    lastHandshake: "22s ago",
    createdAt: "2026-11-01",
    publicKey: "pe//+gsSBGxQ/Mv96w5N0EaOqsU3N8i9pvvhBoYrH0A=",
  },
];

export const seedRuleGroups: RuleGroup[] = [
  { id: "ads", label: "Ads and trackers", domains: 38, enabled: true },
  { id: "social", label: "Social", domains: 12, enabled: true },
  { id: "streaming", label: "Streaming", domains: 9, enabled: false },
  { id: "malware", label: "Malware and phishing", domains: 54, enabled: true },
];

export const seedIpBlocks: IpBlock[] = [
  {
    id: "ip-1",
    cidr: "198.51.100.0/24",
    scope: "All peers",
    addedAt: "Oct 28",
  },
  {
    id: "ip-2",
    cidr: "203.0.113.42",
    scope: "Mira Chen",
    addedAt: "Nov 04",
  },
  {
    id: "ip-3",
    cidr: "2001:db8::/32",
    scope: "All peers",
    addedAt: "Nov 09",
  },
];

export const seedActivity: Activity[] = [
  {
    id: "a-1",
    kind: "peer",
    action: "Issued a peer",
    detail: "Aisha Rahman / iPhone 16 / sgp-1",
    at: "2026-11-13 09:40:12",
    actor: "Demo operator",
  },
  {
    id: "a-2",
    kind: "peer",
    action: "Suspended a peer",
    detail: "Hana Sato / iPad Air / sfo-1",
    at: "2026-11-13 09:22:41",
    actor: "Demo operator",
  },
  {
    id: "a-3",
    kind: "rule",
    action: "Updated a domain group",
    detail: "Social / scope: all peers",
    at: "2026-11-13 08:41:06",
    actor: "Demo operator",
  },
  {
    id: "a-4",
    kind: "node",
    action: "Agent poll completed",
    detail: "sgp-1 / 15s interval",
    at: "2026-11-13 08:39:55",
    actor: "System",
  },
  {
    id: "a-5",
    kind: "backup",
    action: "Created a backup",
    detail: "wgconsole_backup_20261112_031209.sql.gz",
    at: "2026-11-13 03:12:09",
    actor: "Demo operator",
  },
  {
    id: "a-6",
    kind: "auth",
    action: "Passkey sign-in",
    detail: "demo@console.local / Chrome on macOS",
    at: "2026-11-13 03:10:44",
    actor: "Demo operator",
  },
];

export const trafficSeries = [
  2.1, 3.4, 2.8, 4.6, 3.5, 5.2, 4.1, 3.9, 5.8, 4.4, 5.1, 6.0, 4.7, 5.2,
];

export const trafficLabels = ["Oct 30", "Nov 02", "Nov 05", "Nov 08", "Nov 11"];

export const ruleScopeOptions = [
  "All peers",
  "Engineering",
  "Design",
  "Sales",
  "Finance",
  "Support",
] as const;

export function formatBytes(totalGb: number) {
  return `${totalGb.toFixed(1)} GB`;
}

export function peerInitials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function buildPeerConfig(peer: Peer, region: Region) {
  return `[Interface]
PrivateKey = 6Kq2s9d4u1nXh3f8mB5vC7pL0aR2tY4eW6gH8jN1qS=
Address = ${peer.ip}/32
DNS = ${region.dns}, 1.1.1.1

[Peer]
PublicKey = 9tR4cV2wX8yZ1sQ5nM7kJ3hF6dA0bG9eL2pU4iO8aS=
PresharedKey = 2fD4gH6jK8lM0nP2qR4sT6uV8wX0yZ2aB4cD6eF8gH0=
Endpoint = ${region.endpoint}
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25`;
}

export function emailFor(name: string) {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "")}@example.com`;
}

export function createJoinCommand(region: Region) {
  return `curl -fsSL https://raw.githubusercontent.com/garyhooi/wireguard-console/main/node-install.sh \\\n  | sudo bash -s -- demo-token-${region.id} https://console.example.com ${region.code}`;
}

export function isCidr(value: string) {
  const trimmed = value.trim();
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
  const ipv6 = /^[0-9a-f:]+(\/\d{1,3})?$/i;
  if (!ipv4.test(trimmed) && !ipv6.test(trimmed)) return false;
  if (trimmed.includes("/")) {
    const bits = Number(trimmed.split("/")[1]);
    const max = trimmed.includes(":") ? 128 : 32;
    if (Number.isNaN(bits) || bits < 0 || bits > max) return false;
  }
  if (ipv4.test(trimmed)) {
    const octets = trimmed.split("/")[0].split(".").map(Number);
    return octets.every((octet) => octet >= 0 && octet <= 255);
  }
  return true;
}
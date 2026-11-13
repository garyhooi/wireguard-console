"use client";

import { useDemo } from "@/components/demo/store";
import {
  Badge,
  PageHeader,
  Panel,
  Stat,
  StatusBadge,
  tableCls,
  tdCls,
  thCls,
} from "@/components/demo/ui";

const ALLOWED = [
  { name: "github.com", count: 1482 },
  { name: "docs.github.com", count: 936 },
  { name: "slack.com", count: 811 },
  { name: "google.com", count: 602 },
  { name: "registry.npmjs.org", count: 518 },
];

const BLOCKED = [
  { name: "doubleclick.net", count: 214 },
  { name: "facebook.com", count: 138 },
  { name: "tiktok.com", count: 92 },
  { name: "ads.example.net", count: 61 },
];

const BLOCKED_IPS = [
  { name: "198.51.100.0/24", count: 47 },
  { name: "203.0.113.42", count: 19 },
  { name: "2001:db8::/32", count: 8 },
];

const TOP_PEERS = [
  { name: "Mira Chen", value: "12.4 GB" },
  { name: "Aisha Rahman", value: "9.1 GB" },
  { name: "Tomasz Nowak", value: "7.8 GB" },
  { name: "Noah Williams", value: "5.2 GB" },
  { name: "Lucas Ferreira", value: "4.6 GB" },
];

const SERIES = [
  18, 22, 19, 25, 31, 28, 35, 42, 38, 44, 52, 49, 58, 61, 56, 64, 70, 66, 72,
  68, 75, 71, 78, 74,
];

function TrafficChart() {
  const max = Math.max(...SERIES);
  const points = SERIES.map((value, index) => {
    const x = (index / (SERIES.length - 1)) * 600;
    const y = 132 - (value / max) * 108;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const area = `0,140 ${points} 600,140`;
  return (
    <div className="px-5 pb-4 pt-2">
      <div className="mb-2 flex items-center gap-4 text-[11px] text-dim">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-teal-400" />
          Download
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />
          Upload
        </span>
        <span className="ml-auto font-mono tabular-nums">24h</span>
      </div>
      <svg
        viewBox="0 0 600 150"
        preserveAspectRatio="none"
        role="img"
        aria-label="Traffic over the last 24 hours, peaking in the evening"
        className="h-40 w-full"
      >
        <defs>
          <linearGradient id="traffic-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3].map((line) => (
          <line
            key={line}
            x1="0"
            x2="600"
            y1={24 + line * 36}
            y2={24 + line * 36}
            stroke="#27272a"
            strokeWidth="1"
            strokeDasharray="3 6"
          />
        ))}
        <polygon points={area} fill="url(#traffic-fill)" />
        <polyline
          points={points}
          fill="none"
          stroke="#2dd4bf"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <div className="mt-2 flex justify-between font-mono text-[10px] text-dim">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>now</span>
      </div>
    </div>
  );
}

function TopList({
  items,
  blocked,
}: {
  items: Array<{ name: string; count: number }>;
  blocked?: boolean;
}) {
  const max = items[0]?.count ?? 1;
  return (
    <ul className="divide-y divide-zinc-800/60">
      {items.map((item) => (
        <li key={item.name} className="px-5 py-2.5">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate font-mono text-xs text-zinc-300">
              {item.name}
            </span>
            <span
              className={
                blocked
                  ? "font-mono text-xs tabular-nums text-red-400"
                  : "font-mono text-xs tabular-nums text-teal-400"
              }
            >
              {item.count.toLocaleString()}
            </span>
          </div>
          <div className="mt-1.5 h-1 rounded-full bg-zinc-800">
            <div
              className={
                blocked
                  ? "h-1 rounded-full bg-red-500/50"
                  : "h-1 rounded-full bg-teal-500/50"
              }
              style={{ width: `${Math.max(8, (item.count / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function StatisticsView() {
  const { peers } = useDemo();
  const connected = peers.filter(
    (peer) => peer.status === "active" && peer.lastHandshake !== "never",
  ).length;

  return (
    <div>
      <PageHeader
        title="Statistics"
        description="Kernel-sampled traffic from every managed interface, aggregated hourly. Numbers refresh every 30 seconds."
      />

      <Panel>
        <div className="grid grid-cols-2 divide-x divide-y divide-zinc-800 lg:grid-cols-3 lg:divide-y-0">
          <Stat label="Download · 24h" value="48.2 GB" tone="good" />
          <Stat label="Upload · 24h" value="9.6 GB" />
          <Stat
            label="Connected peers"
            value={connected}
            tone={connected > 0 ? "good" : "default"}
            sub={`of ${peers.length} peers`}
          />
        </div>
      </Panel>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Panel
          title="Top domains browsed · last 7 days"
          description="Most-resolved domains allowed by the DNS filter."
        >
          <TopList items={ALLOWED} />
        </Panel>
        <Panel
          title="Blocked domain attempts"
          description="Domains users tried to reach that the filter refused."
        >
          <TopList items={BLOCKED} blocked />
        </Panel>
        <Panel
          title="Blocked IP attempts"
          description="IP destinations dropped by IP rules."
        >
          <TopList items={BLOCKED_IPS} blocked />
          <p className="px-5 pb-4 text-xs text-dim">74 dropped hits</p>
        </Panel>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title="Traffic over time · last 24h">
          <TrafficChart />
        </Panel>
        <Panel title="Top peers by volume · last 24h">
          <ul className="divide-y divide-zinc-800/60">
            {TOP_PEERS.map((peer, index) => (
              <li
                key={peer.name}
                className="flex items-center justify-between gap-3 px-5 py-3 text-sm"
              >
                <span className="flex items-center gap-3">
                  <span className="w-4 text-right font-mono text-xs text-dim">
                    {index + 1}
                  </span>
                  <span className="text-zinc-300">{peer.name}</span>
                </span>
                <span className="font-mono text-xs tabular-nums text-teal-400">
                  {peer.value}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="mt-8">
        <Panel title="Peer state">
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-dim">
                  <th className={thCls}>Peer</th>
                  <th className={thCls}>Tunnel IP</th>
                  <th className={thCls}>Status</th>
                  <th className={thCls}>Last handshake</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {peers.map((peer) => (
                  <tr key={peer.id} className="transition-colors hover:bg-zinc-800/30">
                    <td className="px-5 py-3 text-sm text-zinc-200">
                      <span className="flex items-center gap-2">
                        {peer.name}
                        <Badge tone="neutral">{peer.kind}</Badge>
                      </span>
                    </td>
                    <td className={tdCls + " font-mono"}>{peer.ip}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={peer.status} />
                    </td>
                    <td className={tdCls + " font-mono tabular-nums"}>
                      {peer.lastHandshake === "never"
                        ? "Never"
                        : peer.lastHandshake}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  );
}

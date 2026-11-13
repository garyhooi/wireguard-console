"use client";

import { useMemo, useState } from "react";
import { useDemo } from "@/components/demo/store";
import {
  Badge,
  PageHeader,
  Panel,
  tabGroupCls,
  tableCls,
  tdCls,
  thCls,
  toolbarTab,
} from "@/components/demo/ui";

const SAMPLE = [
  { allowed: 482, blocked: 12, last: "2m ago" },
  { allowed: 366, blocked: 4, last: "11m ago" },
  { allowed: 254, blocked: 31, last: "4m ago" },
  { allowed: 198, blocked: 0, last: "23m ago" },
  { allowed: 121, blocked: 18, last: "1h ago" },
  { allowed: 96, blocked: 2, last: "48m ago" },
  { allowed: 74, blocked: 9, last: "2h ago" },
];

const BLOCKED_IPS = [
  {
    time: "2026-11-13 09:31:44",
    user: "Mira Chen",
    dest: "198.51.100.0/24",
    packets: 47,
  },
  {
    time: "2026-11-13 08:58:12",
    user: "Hana Sato",
    dest: "203.0.113.42",
    packets: 19,
  },
  {
    time: "2026-11-13 08:14:03",
    user: "All peers",
    dest: "2001:db8::/32",
    packets: 8,
  },
];

export function WebActivityView() {
  const { peers } = useDemo();
  const [scope, setScope] = useState<"user" | "peer">("user");
  const [status, setStatus] = useState<"all" | "allowed" | "blocked">("all");

  const rows = useMemo(() => {
    if (scope === "peer") {
      return peers.map((peer, index) => ({
        id: peer.id,
        label: peer.name,
        sub: peer.device,
        peers: 1,
        ...SAMPLE[index % SAMPLE.length],
      }));
    }
    const grouped = new Map<
      string,
      { label: string; sub: string; peers: number; allowed: number; blocked: number; last: string }
    >();
    peers.forEach((peer, index) => {
      const sample = SAMPLE[index % SAMPLE.length];
      const existing = grouped.get(peer.name);
      if (existing) {
        existing.peers += 1;
        existing.allowed += sample.allowed;
        existing.blocked += sample.blocked;
      } else {
        grouped.set(peer.name, {
          label: peer.name,
          sub: peer.department,
          peers: 1,
          allowed: sample.allowed,
          blocked: sample.blocked,
          last: sample.last,
        });
      }
    });
    return Array.from(grouped.values()).map((row, index) => ({
      id: `user-${index}`,
      ...row,
    }));
  }, [peers, scope]);

  const filtered = rows.filter((row) => {
    if (status === "blocked") return row.blocked > 0;
    if (status === "allowed") return row.allowed > 0;
    return true;
  });

  return (
    <div>
      <PageHeader
        title="Web Activity"
        description="Per-VPN-user and per-peer web activity from the DNS queries each peer sends through the tunnel's AdGuard filter. Blocked rows are domains the filter refused; everything else was allowed. Data is imported from AdGuard Home every 30 seconds."
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className={tabGroupCls}>
          {([["user", "By VPN user"], ["peer", "By peer"]] as const).map(
            ([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setScope(value)}
                className={toolbarTab(
                  scope === value,
                  "bg-teal-700 text-white",
                )}
              >
                {label}
              </button>
            ),
          )}
        </div>

        <div className={tabGroupCls}>
          {(["all", "allowed", "blocked"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setStatus(value)}
              className={toolbarTab(
                status === value,
                "bg-zinc-700 text-white",
              )}
            >
              {value === "all"
                ? "All"
                : value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2 text-xs text-dim">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-teal-400" />
            Allowed
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
            Blocked
          </span>
        </div>
      </div>

      <Panel
        title={scope === "user" ? "VPN users" : "Peers"}
        description="Allowed vs blocked lookups over the last 7 days."
      >
        <div className="overflow-x-auto">
          <table className={tableCls}>
            <thead>
              <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-dim">
                <th className={thCls}>{scope === "user" ? "VPN user" : "Peer"}</th>
                {scope === "user" && <th className={thCls + " text-right"}>Peers</th>}
                <th className={thCls + " text-right"}>Allowed</th>
                <th className={thCls + " text-right"}>Blocked</th>
                <th className={thCls}>Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {filtered.map((row) => (
                <tr
                  key={row.id}
                  className="transition-colors hover:bg-zinc-800/30"
                >
                  <td className="whitespace-nowrap px-5 py-3.5">
                    <p className="text-sm text-zinc-200">{row.label}</p>
                    <p className="mt-0.5 text-xs text-dim">{row.sub}</p>
                  </td>
                  {scope === "user" && (
                    <td className={tdCls + " text-right font-mono tabular-nums"}>
                      {row.peers}
                    </td>
                  )}
                  <td className="px-5 py-3.5 text-right font-mono text-sm tabular-nums text-teal-400">
                    {row.allowed.toLocaleString()}
                  </td>
                  <td className="px-5 py-3.5 text-right font-mono text-sm tabular-nums">
                    {row.blocked > 0 ? (
                      <span className="text-red-400">
                        {row.blocked.toLocaleString()}
                        <span className="ml-2 text-[11px] text-dim">
                          ({Math.round((row.blocked / (row.allowed + row.blocked)) * 100)}%)
                        </span>
                      </span>
                    ) : (
                      <span className="text-dim">0</span>
                    )}
                  </td>
                  <td className={tdCls + " font-mono tabular-nums"}>{row.last}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Blocked IP attempts · last 7 days" className="mt-6">
        <div className="overflow-x-auto">
          <table className={tableCls}>
            <thead>
              <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-dim">
                <th className={thCls}>Time</th>
                <th className={thCls}>User</th>
                <th className={thCls}>Destination</th>
                <th className={thCls + " text-right"}>Packets</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {BLOCKED_IPS.map((row) => (
                <tr
                  key={row.time}
                  className="transition-colors hover:bg-zinc-800/30"
                >
                  <td className={tdCls + " font-mono text-xs"}>{row.time}</td>
                  <td className={tdCls}>{row.user}</td>
                  <td className={tdCls}>
                    <span className="font-mono text-zinc-300">{row.dest}</span>
                  </td>
                  <td className={tdCls + " text-right font-mono tabular-nums"}>
                    {row.packets}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <p className="mt-3 flex items-center gap-2 text-xs text-dim">
        <Badge tone="neutral">AdGuard Home</Badge>
        Query log imported every 30 seconds. Demo data is static.
      </p>
    </div>
  );
}

"use client";

import { IconArrowRight, IconPlus } from "@tabler/icons-react";
import { useDemo } from "@/components/demo/store";
import {
  EmptyState,
  PageHeader,
  Panel,
  PrimaryButton,
  Stat,
  StatusBadge,
  tdCls,
  thCls,
} from "@/components/demo/ui";

export function DashboardView() {
  const { peers, regions, setView } = useDemo();

  const totalPeers = peers.length;
  const activePeers = peers.filter((peer) => peer.status === "active");
  const suspended = totalPeers - activePeers.length;
  const connected = activePeers.filter(
    (peer) => peer.lastHandshake !== "never",
  ).length;
  const users = new Set(peers.map((peer) => peer.name)).size;
  const activeUsers = new Set(activePeers.map((peer) => peer.name)).size;
  const recent = peers.slice(0, 8);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Live state of your WireGuard mesh: peers, users and nodes across every managed server."
      />

      <Panel>
        <div className="grid grid-cols-2 divide-x divide-y divide-zinc-800 lg:grid-cols-4 lg:divide-y-0">
          <Stat label="Peers" value={totalPeers} sub="total issued" />
          <Stat
            label="Connected"
            value={connected}
            tone={connected > 0 ? "good" : "default"}
            sub="live handshakes"
          />
          <Stat
            label="Suspended"
            value={suspended}
            tone={suspended > 0 ? "warn" : "default"}
            sub="of active configs"
          />
          <Stat label="Users" value={users} sub="with VPN access" />
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-zinc-800 border-t border-zinc-800 lg:grid-cols-3 lg:divide-y-0">
          <Stat label="Servers" value={regions.length} sub="managed" />
          <Stat label="Active users" value={activeUsers} sub="activated" />
          <Stat
            label="Active peers"
            value={activePeers.length}
            tone="good"
            sub="enabled"
          />
        </div>
      </Panel>

      <div className="mt-8">
        <Panel
          title="Recent peers"
          right={
            <button
              type="button"
              onClick={() => setView("peers")}
              className="inline-flex items-center gap-1 text-xs text-teal-400 transition-colors hover:text-teal-300"
            >
              View all
              <IconArrowRight size={14} stroke={1.6} aria-hidden="true" />
            </button>
          }
        >
          {recent.length === 0 ? (
            <EmptyState
              title="No peers yet"
              hint="Add a peer on the Peers page and its tunnel config is generated automatically."
              action={
                <PrimaryButton onClick={() => setView("peers")}>
                  <IconPlus size={16} stroke={1.6} aria-hidden="true" />
                  Add peer
                </PrimaryButton>
              }
            />
          ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-zinc-800/80">
              <thead>
                <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-dim">
                  <th className={thCls}>Peer</th>
                  <th className={thCls}>Tunnel IP</th>
                  <th className={thCls}>Status</th>
                  <th className={thCls}>Last Handshake</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {recent.map((peer) => {
                  const region = regions.find(
                    (item) => item.id === peer.regionId,
                  );
                  return (
                    <tr
                      key={peer.id}
                      className="transition-colors hover:bg-zinc-800/30"
                    >
                      <td className="whitespace-nowrap px-5 py-3.5 text-sm">
                        <p className="text-zinc-200">{peer.name}</p>
                        <p className="mt-0.5 text-xs text-dim">
                          {peer.device} / {region?.code ?? "unassigned"}
                        </p>
                      </td>
                      <td className={tdCls + " font-mono"}>{peer.ip}</td>
                      <td className="whitespace-nowrap px-5 py-3.5">
                        <StatusBadge status={peer.status} />
                      </td>
                      <td className={tdCls + " font-mono tabular-nums"}>
                        {peer.lastHandshake === "never"
                          ? "Never"
                          : peer.lastHandshake}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
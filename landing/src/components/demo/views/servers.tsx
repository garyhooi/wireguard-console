"use client";

import { useState } from "react";
import { IconTerminal2 } from "@tabler/icons-react";
import { useDemo } from "@/components/demo/store";
import type { Region } from "@/components/demo/data";
import {
  ActionLink,
  Badge,
  CopyButton,
  GhostButton,
  Modal,
  PageHeader,
  StatusBadge,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
} from "@/components/demo/ui";

function hostConfig(region: Region) {
  return `[Interface]
Address = ${region.dns}/24
ListenPort = 51820
PrivateKey = <managed by console>
SaveConfig = false

# Peers are added by the console on the next agent poll.
# The agent owns this file; edit it in the console, not on the host.`;
}

export function ServersView() {
  const { regions, peers } = useDemo();
  const [setupRegion, setSetupRegion] = useState<Region | null>(null);

  return (
    <div>
      <PageHeader
        title="Servers"
        description="WireGuard interfaces managed by this console. Each exit owns one interface, one endpoint and one subnet."
      />

      <div className={tableWrapCls}>
        <div className="overflow-x-auto">
          <table className={tableCls}>
            <thead>
              <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-dim">
                <th className={thCls}>Server</th>
                <th className={thCls}>Endpoint</th>
                <th className={thCls}>Interface</th>
                <th className={thCls}>Network</th>
                <th className={thCls}>Public Key</th>
                <th className={thCls}>Peers</th>
                <th className={thCls}>Status</th>
                <th className={thCls + " text-right"}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {regions.map((region) => {
                const count = peers.filter(
                  (peer) => peer.regionId === region.id,
                ).length;
                return (
                  <tr
                    key={region.id}
                    className="transition-colors hover:bg-zinc-800/30"
                  >
                    <td className="whitespace-nowrap px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 text-dim">
                          <IconTerminal2
                            size={14}
                            stroke={1.6}
                            aria-hidden="true"
                          />
                        </span>
                        <div>
                          <p className="text-sm text-zinc-200">
                            {region.city} VPN
                          </p>
                          <p className="mt-0.5 font-mono text-xs text-dim">
                            {region.code} / {region.zone}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className={tdCls + " font-mono"}>
                      {region.endpoint}
                    </td>
                    <td className={tdCls}>
                      <Badge tone="neutral">wg0</Badge>
                    </td>
                    <td className={tdCls + " font-mono"}>{region.subnet}</td>
                    <td className={tdCls + " font-mono"}>
                      {region.serverPublicKey.substring(0, 16)}…
                    </td>
                    <td className={tdCls + " font-mono tabular-nums"}>
                      {count}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5">
                      <StatusBadge
                        status={region.status === "ok" ? "active" : "joining"}
                      />
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5 text-right">
                      <ActionLink
                        tone="accent"
                        onClick={() => setSetupRegion(region)}
                      >
                        <IconTerminal2
                          size={14}
                          stroke={1.6}
                          aria-hidden="true"
                        />
                        Host setup
                      </ActionLink>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={Boolean(setupRegion)}
        onClose={() => setSetupRegion(null)}
        title="Host setup"
        description={
          setupRegion
            ? `The agent writes this interface on ${setupRegion.city} at its next poll. Peers are managed by the console.`
            : undefined
        }
        className="max-w-2xl"
        footer={
          <GhostButton onClick={() => setSetupRegion(null)}>Close</GhostButton>
        }
      >
        {setupRegion && (
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-dim">
              <Badge tone="neutral">{setupRegion.code}</Badge>
              <span className="font-mono">{setupRegion.endpoint}</span>
              <span className="text-dim">/</span>
              <span className="font-mono">{setupRegion.subnet}</span>
            </div>
            <pre className="thin-scroll overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-300">
              <code>{hostConfig(setupRegion)}</code>
            </pre>
            <div className="mt-4 flex justify-end">
              <CopyButton value={hostConfig(setupRegion)} label="Copy config" />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
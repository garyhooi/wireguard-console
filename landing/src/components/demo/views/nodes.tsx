"use client";

import { useState } from "react";
import {
  IconPlus,
  IconTerminal2,
} from "@tabler/icons-react";
import { useDemo } from "@/components/demo/store";
import {
  createJoinCommand,
  type Region,
} from "@/components/demo/data";
import {
  ActionLink,
  Badge,
  CopyButton,
  GhostButton,
  Modal,
  PageHeader,
  PrimaryButton,
  StatusBadge,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
} from "@/components/demo/ui";

export function NodesView() {
  const { regions, openAddNode } = useDemo();
  const [joinRegion, setJoinRegion] = useState<Region | null>(null);
  const waiting = regions.filter((region) => region.status === "joining");

  return (
    <div>
      <PageHeader
        title="Nodes"
        description="Every exit runs a small agent that dials out to this console over HTTPS. No inbound management ports, no SSH after install."
        actions={
          <PrimaryButton onClick={openAddNode}>
            <IconPlus size={16} stroke={1.6} aria-hidden="true" />
            Add Node
          </PrimaryButton>
        }
      />

      {waiting.length > 0 && (
        <div
          role="status"
          className="mb-5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-300"
        >
          {waiting.length} node{waiting.length === 1 ? "" : "s"} waiting for a
          first agent poll. The agent reports every 15 seconds.
        </div>
      )}

      <div className={tableWrapCls}>
        <div className="overflow-x-auto">
          <table className={tableCls}>
            <thead>
              <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-dim">
                <th className={thCls}>Node</th>
                <th className={thCls}>Status</th>
                <th className={thCls}>Agent Version</th>
                <th className={thCls}>Servers</th>
                <th className={thCls}>Last Seen</th>
                <th className={thCls}>Agent Status</th>
                <th className={thCls + " text-right"}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {regions.map((region) => (
                <tr
                  key={region.id}
                  className="transition-colors hover:bg-zinc-800/30"
                >
                  <td className="whitespace-nowrap px-5 py-3.5">
                    <p className="text-sm text-zinc-200">{region.city}</p>
                    <p className="mt-0.5 font-mono text-xs text-dim">
                      {region.code} / {region.zone}
                    </p>
                  </td>
                  <td className="whitespace-nowrap px-5 py-3.5">
                    <StatusBadge status={region.status} />
                  </td>
                  <td className={tdCls + " font-mono"}>v1.2.0</td>
                  <td className={tdCls + " font-mono tabular-nums"}>
                    {region.servers}
                  </td>
                  <td className={tdCls + " font-mono tabular-nums"}>
                    {region.lastPoll}
                  </td>
                  <td className={tdCls}>
                    {region.status === "ok" ? (
                      <span className="text-teal-400">ok</span>
                    ) : (
                      <span className="text-amber-400">waiting for first poll</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-5 py-3.5 text-right">
                    <ActionLink
                      tone="accent"
                      onClick={() => setJoinRegion(region)}
                    >
                      <IconTerminal2
                        size={14}
                        stroke={1.6}
                        aria-hidden="true"
                      />
                      Join command
                    </ActionLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={Boolean(joinRegion)}
        onClose={() => setJoinRegion(null)}
        title="Join command"
        description={
          joinRegion
            ? `Run this on the ${joinRegion.city} host. The token is shown once when the node is created.`
            : undefined
        }
        className="max-w-2xl"
        footer={
          <GhostButton onClick={() => setJoinRegion(null)}>Close</GhostButton>
        }
      >
        {joinRegion && (
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-dim">
              <Badge tone="neutral">{joinRegion.code}</Badge>
              <span className="font-mono">{joinRegion.subnet}</span>
              <span className="text-dim">/</span>
              <span className="font-mono">{joinRegion.endpoint}</span>
            </div>
            <pre className="thin-scroll overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-300">
              <code>{createJoinCommand(joinRegion)}</code>
            </pre>
            <div className="mt-4 flex justify-end">
              <CopyButton value={createJoinCommand(joinRegion)} label="Copy command" />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
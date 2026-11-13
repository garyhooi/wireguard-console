"use client";

import { useState } from "react";
import { IconCpu, IconRefresh } from "@tabler/icons-react";
import { useDemo } from "@/components/demo/store";
import {
  Badge,
  GhostButton,
  PageHeader,
  Panel,
} from "@/components/demo/ui";

type Machine = {
  id: string;
  name: string;
  sub: string;
  status: "online" | "joining";
  cpu: number;
  memory: number;
  disk: number;
  load: string;
  uptime: string;
  version: string;
  seen: string;
};

function Metric({ label, value }: { label: string; value: number }) {
  const tone =
    value >= 85 ? "bg-red-400" : value >= 65 ? "bg-amber-400" : "bg-teal-400";
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="text-dim">{label}</span>
        <span className="font-mono tabular-nums text-zinc-300">{value}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function MachineCard({ machine }: { machine: Machine }) {
  return (
    <Panel className="flex flex-col">
      <div className="flex items-start justify-between gap-3 px-5 pb-2 pt-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-zinc-200">
            {machine.name}
          </p>
          <p className="mt-0.5 truncate font-mono text-xs text-dim">
            {machine.sub}
          </p>
        </div>
        <Badge tone={machine.status === "online" ? "good" : "warn"}>
          {machine.status === "online" ? "online" : "waiting"}
        </Badge>
      </div>

      <div className="space-y-3.5 px-5 py-4">
        <Metric label="CPU" value={machine.cpu} />
        <Metric label="Memory" value={machine.memory} />
        <Metric label="Disk" value={machine.disk} />
      </div>

      <dl className="mt-auto grid grid-cols-3 gap-2 border-t border-zinc-800 px-5 py-3 text-xs">
        <div>
          <dt className="text-dim">Load</dt>
          <dd className="mt-0.5 font-mono tabular-nums text-zinc-300">
            {machine.load}
          </dd>
        </div>
        <div>
          <dt className="text-dim">Uptime</dt>
          <dd className="mt-0.5 font-mono tabular-nums text-zinc-300">
            {machine.uptime}
          </dd>
        </div>
        <div>
          <dt className="text-dim">Agent</dt>
          <dd className="mt-0.5 font-mono tabular-nums text-zinc-300">
            {machine.version}
          </dd>
        </div>
      </dl>
      <div className="border-t border-zinc-800 px-5 py-2.5 font-mono text-[11px] text-dim">
        last report {machine.seen}
      </div>
    </Panel>
  );
}

export function ServerMonitoringView() {
  const { regions, pushToast } = useDemo();
  const [refreshed, setRefreshed] = useState("just now");

  const machines: Machine[] = [
    {
      id: "console",
      name: "console",
      sub: "Console host",
      status: "online",
      cpu: 18,
      memory: 42,
      disk: 38,
      load: "0.31",
      uptime: "18d 4h",
      version: "v1.2.0",
      seen: "2s ago",
    },
    ...regions.map((region, index) => ({
      id: region.id,
      name: `${region.city} edge`,
      sub: `${region.code} / ${region.zone}`,
      status: region.status === "ok" ? ("online" as const) : ("joining" as const),
      cpu: [22, 34, 27, 19, 41][index % 5],
      memory: [48, 56, 39, 44, 52][index % 5],
      disk: [37, 51, 44, 29, 62][index % 5],
      load: ["0.42", "0.71", "0.39", "0.22", "0.64"][index % 5],
      uptime: ["12d 7h", "31d 2h", "9d 11h", "4d 18h", "22d 5h"][index % 5],
      version: "v1.2.0",
      seen: region.lastPoll,
    })),
  ];

  function refresh() {
    setRefreshed("just now");
    pushToast("Metrics refreshed", "info");
  }

  return (
    <div>
      <PageHeader
        title="Server Monitoring"
        description="Live resource health of every WireGuard machine, remote nodes and the console host, refreshed every 15 seconds."
        actions={
          <GhostButton onClick={refresh}>
            <IconRefresh size={16} stroke={1.6} aria-hidden="true" />
            Refresh
          </GhostButton>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {machines.map((machine) => (
          <MachineCard key={machine.id} machine={machine} />
        ))}
      </div>

      <p className="mt-4 flex items-center gap-1.5 text-xs text-dim">
        <IconCpu size={13} stroke={1.6} aria-hidden="true" />
        Metrics are collected by the wg-helper agent on each machine and
        reported to this console every ~15s. Snapshot {refreshed}.
      </p>
    </div>
  );
}

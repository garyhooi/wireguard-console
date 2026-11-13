"use client";

import { useMemo, useState } from "react";
import {
  IconDeviceDesktop,
  IconKey,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useDemo } from "@/components/demo/store";
import {
  ActionLink,
  EmptyState,
  PageHeader,
  PrimaryButton,
  StatusBadge,
  inputCls,
  selectInlineCls,
  tabGroupCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
  toolbarCls,
  toolbarTab,
} from "@/components/demo/ui";

const STATUS_TABS = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "suspended", label: "Suspended" },
] as const;

type StatusTab = (typeof STATUS_TABS)[number]["id"];

export function PeersView() {
  const {
    peers,
    regions,
    openIssue,
    openConfig,
    openRevoke,
  } = useDemo();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusTab>("all");
  const [regionId, setRegionId] = useState("all");

  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return peers.filter((peer) => {
      if (status !== "all" && peer.status !== status) return false;
      if (regionId !== "all" && peer.regionId !== regionId) return false;
      if (!search) return true;
      return (
        peer.name.toLowerCase().includes(search) ||
        peer.device.toLowerCase().includes(search) ||
        peer.ip.includes(search) ||
        peer.department.toLowerCase().includes(search)
      );
    });
  }, [peers, query, regionId, status]);

  return (
    <div>
      <PageHeader
        title="Peers"
        description="One peer is one device (laptop, phone…) for a user on a server. Keys and the tunnel IP are generated automatically."
        actions={
          <PrimaryButton onClick={() => openIssue()}>
            <IconPlus size={16} stroke={1.6} aria-hidden="true" />
            Add Peer
          </PrimaryButton>
        }
      />

      <div className={toolbarCls}>
        <div className={tabGroupCls}>
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setStatus(tab.id)}
              className={toolbarTab(
                status === tab.id,
                "bg-teal-500/10 text-teal-300",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <IconSearch
            size={14}
            stroke={1.7}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim"
            aria-hidden="true"
          />
          <input
            id="peer-search"
            name="peerSearch"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, device, IP…"
            aria-label="Search peers"
            className={`${inputCls} py-1.5 pl-8 text-sm`}
          />
        </div>

        <select
          id="peer-exit-filter"
          name="peerExit"
          value={regionId}
          onChange={(event) => setRegionId(event.target.value)}
          aria-label="Filter by server"
          className={`${selectInlineCls} py-1.5`}
        >
          <option value="all">All servers</option>
          {regions.map((region) => (
            <option key={region.id} value={region.id}>
              {region.city}
            </option>
          ))}
        </select>

        <span className="ml-auto font-mono text-xs tabular-nums text-dim">
          {filtered.length} / {peers.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className={tableWrapCls}>
          <EmptyState
            title="No peers match those filters"
            hint="Try another server or status. New peers appear at the top of the table."
            action={
              <PrimaryButton onClick={() => openIssue()}>
                <IconPlus size={16} stroke={1.6} aria-hidden="true" />
                Add peer
              </PrimaryButton>
            }
          />
        </div>
      ) : (
        <div className={tableWrapCls}>
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-dim">
                  <th className={thCls}>Name</th>
                  <th className={thCls}>Server</th>
                  <th className={thCls}>User</th>
                  <th className={thCls + " hidden min-[1700px]:table-cell"}>Public Key</th>
                  <th className={thCls}>Allowed IP</th>
                  <th className={thCls}>Status</th>
                  <th className={thCls}>Last Handshake</th>
                  <th className={thCls + " text-right"}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {filtered.map((peer) => {
                  const region = regions.find(
                    (item) => item.id === peer.regionId,
                  );
                  return (
                    <tr
                      key={peer.id}
                      className="transition-colors hover:bg-zinc-800/30"
                    >
                      <td className="whitespace-nowrap px-5 py-3.5">
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 text-dim">
                            <IconDeviceDesktop
                              size={14}
                              stroke={1.6}
                              aria-hidden="true"
                            />
                          </span>
                          <div>
                            <p className="text-sm text-zinc-200">
                              {peer.device}
                            </p>
                            <p className="mt-0.5 text-xs text-dim">
                              {peer.kind} / {peer.department}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className={tdCls}>{region?.city ?? "Unassigned"}</td>
                      <td className={tdCls}>{peer.name}</td>
                      <td className={tdCls + " hidden font-mono min-[1700px]:table-cell"}>
                        {peer.publicKey.substring(0, 16)}…
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
                      <td className="whitespace-nowrap px-5 py-3.5 text-right">
                        <div className="flex justify-end gap-1">
                          <ActionLink
                            tone="accent"
                            onClick={() => openConfig(peer.id)}
                          >
                            <IconKey size={14} stroke={1.6} aria-hidden="true" />
                            Config
                          </ActionLink>
                          <ActionLink
                            tone="danger"
                            onClick={() => openRevoke(peer.id)}
                          >
                            <IconTrash size={14} stroke={1.6} aria-hidden="true" />
                            Revoke
                          </ActionLink>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
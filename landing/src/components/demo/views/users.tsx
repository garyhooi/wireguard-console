"use client";

import { useMemo, useState } from "react";
import { IconSearch } from "@tabler/icons-react";
import { useDemo } from "@/components/demo/store";
import { emailFor, type Peer } from "@/components/demo/data";
import {
  EmptyState,
  PageHeader,
  StatusBadge,
  inputCls,
  tabGroupCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
  toolbarCls,
  toolbarTab,
} from "@/components/demo/ui";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "suspended", label: "Suspended" },
] as const;

type UserFilter = (typeof FILTERS)[number]["id"];

type DemoUser = {
  name: string;
  department: string;
  peers: Peer[];
  status: "active" | "suspended";
  lastHandshake: string;
};

export function UsersView() {
  const { peers, regions } = useDemo();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<UserFilter>("all");

  const users = useMemo(() => {
    const grouped = new Map<string, DemoUser>();
    for (const peer of peers) {
      const existing = grouped.get(peer.name);
      if (existing) {
        existing.peers.push(peer);
        if (peer.status === "active") existing.status = "active";
      } else {
        grouped.set(peer.name, {
          name: peer.name,
          department: peer.department,
          peers: [peer],
          status: peer.status,
          lastHandshake: peer.lastHandshake,
        });
      }
    }
    return Array.from(grouped.values());
  }, [peers]);

  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return users.filter((user) => {
      if (filter !== "all" && user.status !== filter) return false;
      if (!search) return true;
      return (
        user.name.toLowerCase().includes(search) ||
        user.department.toLowerCase().includes(search) ||
        emailFor(user.name).includes(search)
      );
    });
  }, [filter, query, users]);

  return (
    <div>
      <PageHeader
        title="VPN Users"
        description="People who receive tunnel configs, separate from the admins who operate this console."
      />

      <div className={toolbarCls}>
        <div className={tabGroupCls}>
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              className={toolbarTab(
                filter === item.id,
                "bg-teal-500/10 text-teal-300",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <IconSearch
            size={14}
            stroke={1.7}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim"
            aria-hidden="true"
          />
          <input
            id="user-search"
            name="userSearch"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search users…"
            aria-label="Search VPN users"
            className={`${inputCls} py-1.5 pl-8`}
          />
        </div>
        <span className="ml-auto font-mono text-xs tabular-nums text-dim">
          {filtered.length} / {users.length}
        </span>
      </div>

      <div className={tableWrapCls}>
        {filtered.length === 0 ? (
          <EmptyState
            title="No users match those filters"
            hint="Try another department or status."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-dim">
                  <th className={thCls}>User</th>
                  <th className={thCls}>Department</th>
                  <th className={thCls}>Peers</th>
                  <th className={thCls}>Exits</th>
                  <th className={thCls}>Last Handshake</th>
                  <th className={thCls}>Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {filtered.map((user) => {
                  const exits = Array.from(
                    new Set(
                      user.peers.map(
                        (peer) =>
                          regions.find((region) => region.id === peer.regionId)
                            ?.code ?? "n/a",
                      ),
                    ),
                  );
                  return (
                    <tr
                      key={user.name}
                      className="transition-colors hover:bg-zinc-800/30"
                    >
                      <td className="whitespace-nowrap px-5 py-3.5">
                        <p className="text-sm text-zinc-200">{user.name}</p>
                        <p className="mt-0.5 text-xs text-dim">
                          {emailFor(user.name)}
                        </p>
                      </td>
                      <td className={tdCls}>{user.department}</td>
                      <td className={tdCls + " font-mono tabular-nums"}>
                        {user.peers.length}
                      </td>
                      <td className={tdCls + " font-mono"}>
                        {exits.join(", ")}
                      </td>
                      <td className={tdCls + " font-mono tabular-nums"}>
                        {user.lastHandshake === "never"
                          ? "Never"
                          : user.lastHandshake}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5">
                        <StatusBadge status={user.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
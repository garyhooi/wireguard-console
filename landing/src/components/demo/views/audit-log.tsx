"use client";

import { useState } from "react";
import { useDemo } from "@/components/demo/store";
import {
  EmptyState,
  PageHeader,
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
  { id: "peer", label: "Peers" },
  { id: "rule", label: "Rules" },
  { id: "system", label: "System" },
] as const;

type Filter = (typeof FILTERS)[number]["id"];

export function AuditLogView() {
  const { activity } = useDemo();
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = activity.filter((event) => {
    if (filter === "all") return true;
    if (filter === "system") {
      return event.kind === "node" || event.kind === "backup" || event.kind === "auth";
    }
    return event.kind === filter;
  });

  return (
    <div>
      <PageHeader
        title="Audit Log"
        description="A read-only record of every admin change: who did it, what changed and when."
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
        <span className="ml-auto font-mono text-xs tabular-nums text-dim">
          {filtered.length} events
        </span>
      </div>

      <div className={tableWrapCls}>
        {filtered.length === 0 ? (
          <EmptyState
            title="No activity in this filter"
            hint="Issue a peer, enable a domain group or add an IP rule. Events appear here immediately."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-dim">
                  <th className={thCls}>Timestamp</th>
                  <th className={thCls}>Action</th>
                  <th className={thCls}>Target</th>
                  <th className={thCls}>IP Address</th>
                  <th className={thCls}>Admin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {filtered.map((event) => (
                  <tr
                    key={event.id}
                    className="transition-colors hover:bg-zinc-800/30"
                  >
                    <td className={tdCls + " font-mono tabular-nums"}>
                      {event.at}
                    </td>
                    <td className={tdCls + " text-zinc-200"}>
                      {event.action}
                    </td>
                    <td className={tdCls}>{event.detail}</td>
                    <td className={tdCls + " font-mono"}>
                      {event.actor === "System" ? "local" : "10.8.0.1"}
                    </td>
                    <td className={tdCls}>{event.actor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
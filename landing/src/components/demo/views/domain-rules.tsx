"use client";

import { useState } from "react";
import { IconPlus, IconShieldCheck } from "@tabler/icons-react";
import { useDemo } from "@/components/demo/store";
import { ruleScopeOptions } from "@/components/demo/data";
import {
  ActionLink,
  Badge,
  Field,
  GhostButton,
  Modal,
  PageHeader,
  Panel,
  PrimaryButton,
  StatusBadge,
  inputCls,
  selectCls,
  selectInlineCls,
  tableCls,
  tdCls,
  thCls,
} from "@/components/demo/ui";

export function DomainRulesView() {
  const {
    dnsEnabled,
    dnsScope,
    ruleGroups,
    setDnsEnabled,
    setDnsScope,
    toggleRule,
    addRuleGroup,
  } = useDemo();

  const [addOpen, setAddOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");

  const domainCount = ruleGroups.reduce((sum, group) => sum + group.domains, 0);

  function openAdd() {
    setLabel("");
    setError("");
    setAddOpen(true);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!label.trim()) {
      setError("Give the group a name.");
      return;
    }
    addRuleGroup(label);
    setAddOpen(false);
  }

  return (
    <div>
      <PageHeader
        title="Domain Blocking"
        description="Block domains at the DNS layer, globally or for one department. AdGuard Home on the console exit receives the compiled rules."
        actions={
          <>
            <GhostButton onClick={() => setDnsEnabled(!dnsEnabled)}>
              {dnsEnabled ? "Disable filtering" : "Enable filtering"}
            </GhostButton>
            <PrimaryButton onClick={openAdd}>
              <IconPlus size={16} stroke={1.6} aria-hidden="true" />
              Add Rule
            </PrimaryButton>
          </>
        }
      />

      <div
        role="status"
        className={
          dnsEnabled
            ? "mb-5 flex items-start gap-3 rounded-lg border border-teal-500/25 bg-teal-500/10 px-4 py-3 text-sm text-teal-300"
            : "mb-5 flex items-start gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-300"
        }
      >
        <IconShieldCheck
          size={17}
          stroke={1.7}
          className="mt-0.5 shrink-0"
          aria-hidden="true"
        />
        <span>
          {dnsEnabled
            ? `Filtering is on. ${domainCount} domains across ${ruleGroups.length} groups are compiled for AdGuard Home.`
            : "Filtering is off. Existing groups are saved and can be re-enabled without rebuilding them."}
        </span>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-zinc-200">Domain groups</h2>
        <div className="flex items-center gap-2 text-xs text-dim">
          <span>Scope</span>
          <select
            id="domain-scope"
            name="domainScope"
            value={dnsScope}
            onChange={(event) => setDnsScope(event.target.value)}
            aria-label="Domain rule scope"
            className={`${selectInlineCls} py-1.5 text-xs`}
          >
            {ruleScopeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Panel>
        <div className="overflow-x-auto">
          <table className={tableCls}>
            <thead>
              <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-dim">
                <th className={thCls}>Group</th>
                <th className={thCls}>Domains</th>
                <th className={thCls}>Scope</th>
                <th className={thCls}>Status</th>
                <th className={thCls + " text-right"}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {ruleGroups.map((group) => (
                <tr
                  key={group.id}
                  className="transition-colors hover:bg-zinc-800/30"
                >
                  <td className="whitespace-nowrap px-5 py-3.5">
                    <p className="text-sm text-zinc-200">{group.label}</p>
                    <p className="mt-0.5 font-mono text-xs text-dim">
                      domain-group / {group.id}
                    </p>
                  </td>
                  <td className={tdCls + " font-mono tabular-nums"}>
                    {group.domains}
                  </td>
                  <td className={tdCls}>
                    <Badge tone="neutral">{dnsScope}</Badge>
                  </td>
                  <td className="whitespace-nowrap px-5 py-3.5">
                    <StatusBadge
                      status={group.enabled ? "enabled" : "disabled"}
                    />
                  </td>
                  <td className="whitespace-nowrap px-5 py-3.5 text-right">
                    <ActionLink
                      tone={group.enabled ? "default" : "accent"}
                      onClick={() => toggleRule(group.id)}
                    >
                      {group.enabled ? "Disable" : "Enable"}
                    </ActionLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Rule"
        description="Create a reusable domain group. In the full console you can add individual domains and block page settings."
        footer={
          <>
            <GhostButton onClick={() => setAddOpen(false)}>Cancel</GhostButton>
            <PrimaryButton type="submit" form="add-domain-group">
              Add group
            </PrimaryButton>
          </>
        }
      >
        <form id="add-domain-group" onSubmit={submit} className="space-y-4">
          <Field label="Group name" htmlFor="domain-group-name" error={error}>
            <input
              id="domain-group-name"
              data-autofocus
              value={label}
              onChange={(event) => {
                setLabel(event.target.value);
                if (error) setError("");
              }}
              placeholder="Contractor blocklist"
              className={inputCls}
            />
          </Field>
          <Field
            label="Scope"
            htmlFor="domain-group-scope"
            hint="New groups inherit the scope selected on the page."
          >
            <select
              id="domain-group-scope"
              value={dnsScope}
              onChange={(event) => setDnsScope(event.target.value)}
              className={selectCls}
            >
              {ruleScopeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-xs text-dim">
            Sample only. The group is stored in this browser tab and is not
            pushed to a real AdGuard instance.
          </p>
        </form>
      </Modal>
    </div>
  );
}
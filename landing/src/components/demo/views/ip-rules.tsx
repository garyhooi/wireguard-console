"use client";

import { useState } from "react";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useDemo } from "@/components/demo/store";
import { isCidr } from "@/components/demo/data";
import {
  ActionLink,
  Badge,
  EmptyState,
  Field,
  GhostButton,
  Modal,
  PageHeader,
  PrimaryButton,
  inputCls,
  selectCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
} from "@/components/demo/ui";

export function IpRulesView() {
  const { ipBlocks, peers, addIpBlock, removeIpBlock } = useDemo();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [scope, setScope] = useState("All peers");
  const [error, setError] = useState("");

  function openAdd() {
    setTarget("");
    setScope("All peers");
    setError("");
    setOpen(true);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = target.trim();
    if (!value) {
      setError("Enter an IPv4, IPv6 or CIDR range.");
      return;
    }
    if (!isCidr(value)) {
      setError("That does not look like an IP address or CIDR range.");
      return;
    }
    if (ipBlocks.some((block) => block.cidr === value)) {
      setError("That range is already blocked.");
      return;
    }
    addIpBlock(value, scope);
    setOpen(false);
  }

  return (
    <div>
      <PageHeader
        title="IP Blocking"
        description="Drop IPv4 and IPv6 addresses or ranges before NAT. Rules apply globally or to a single peer."
        actions={
          <PrimaryButton onClick={openAdd}>
            <IconPlus size={16} stroke={1.6} aria-hidden="true" />
            Add IP Rule
          </PrimaryButton>
        }
      />

      <div className={tableWrapCls}>
        {ipBlocks.length === 0 ? (
          <EmptyState
            title="No IP rules yet"
            hint="Add a documentation range or a known bad address to see how deny rules are listed."
            action={
              <PrimaryButton onClick={openAdd}>
                <IconPlus size={16} stroke={1.6} aria-hidden="true" />
                Add IP rule
              </PrimaryButton>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-dim">
                  <th className={thCls}>Target</th>
                  <th className={thCls}>Family</th>
                  <th className={thCls}>Scope</th>
                  <th className={thCls}>Added</th>
                  <th className={thCls + " text-right"}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {ipBlocks.map((block) => {
                  const ipv6 = block.cidr.includes(":");
                  return (
                    <tr
                      key={block.id}
                      className="transition-colors hover:bg-zinc-800/30"
                    >
                      <td className={tdCls + " font-mono text-zinc-200"}>
                        {block.cidr}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5">
                        <Badge tone="neutral">{ipv6 ? "IPv6" : "IPv4"}</Badge>
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5">
                        <Badge
                          tone={
                            block.scope === "All peers" ? "neutral" : "accent"
                          }
                        >
                          {block.scope}
                        </Badge>
                      </td>
                      <td className={tdCls + " font-mono tabular-nums"}>
                        {block.addedAt}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5 text-right">
                        <ActionLink
                          tone="danger"
                          onClick={() => removeIpBlock(block.id)}
                        >
                          <IconTrash
                            size={14}
                            stroke={1.6}
                            aria-hidden="true"
                          />
                          Remove
                        </ActionLink>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="mt-3 text-xs text-dim">
        Demo rules use documentation ranges and never touch a real firewall.
      </p>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add IP Rule"
        description="Block an address or CIDR range before it is forwarded. Documentation ranges are safe to try."
        footer={
          <>
            <GhostButton onClick={() => setOpen(false)}>Cancel</GhostButton>
            <PrimaryButton type="submit" form="add-ip-rule">
              Block address
            </PrimaryButton>
          </>
        }
      >
        <form id="add-ip-rule" onSubmit={submit} className="space-y-4">
          <Field
            label="IP address or CIDR"
            htmlFor="ip-rule-target"
            hint="For example 198.51.100.0/24, 203.0.113.42 or 2001:db8::/32."
            error={error}
          >
            <input
              id="ip-rule-target"
              data-autofocus
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                if (error) setError("");
              }}
              placeholder="198.51.100.0/24"
              className={`${inputCls} font-mono`}
            />
          </Field>
          <Field label="Scope" htmlFor="ip-rule-scope">
            <select
              id="ip-rule-scope"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              className={selectCls}
            >
              <option>All peers</option>
              {peers.map((peer) => (
                <option key={peer.id} value={peer.name}>
                  {peer.name}
                </option>
              ))}
            </select>
          </Field>
        </form>
      </Modal>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { IconKey, IconSearch, IconUserPlus } from "@tabler/icons-react";
import { useDemo } from "@/components/demo/store";
import {
  ActionLink,
  Badge,
  EmptyState,
  Field,
  GhostButton,
  Modal,
  PageHeader,
  PrimaryButton,
  StatusBadge,
  inputCls,
  selectCls,
  tabGroupCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
  toolbarTab,
} from "@/components/demo/ui";

type Admin = {
  id: string;
  email: string;
  role: "super_admin" | "admin" | "auditor";
  mfa: boolean;
  status: "active" | "disabled" | "invited";
  created: string;
};

const SEED: Admin[] = [
  {
    id: "a-1",
    email: "demo@console.local",
    role: "super_admin",
    mfa: true,
    status: "active",
    created: "2026-01-12",
  },
  {
    id: "a-2",
    email: "ops@console.local",
    role: "admin",
    mfa: true,
    status: "active",
    created: "2026-03-04",
  },
  {
    id: "a-3",
    email: "audit@console.local",
    role: "auditor",
    mfa: true,
    status: "active",
    created: "2026-04-18",
  },
  {
    id: "a-4",
    email: "former@console.local",
    role: "admin",
    mfa: true,
    status: "disabled",
    created: "2025-12-01",
  },
];

const ROLE_LABEL: Record<Admin["role"], string> = {
  super_admin: "super admin",
  admin: "admin",
  auditor: "auditor",
};

export function AdminsView() {
  const { pushToast } = useDemo();
  const [admins, setAdmins] = useState<Admin[]>(SEED);
  const [tab, setTab] = useState<"all" | "active" | "disabled">("all");
  const [query, setQuery] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Admin["role"]>("admin");
  const [error, setError] = useState("");

  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return admins.filter((admin) => {
      if (tab !== "all" && admin.status !== tab) return false;
      if (!search) return true;
      return admin.email.toLowerCase().includes(search);
    });
  }, [admins, query, tab]);

  function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(value)) {
      setError("Enter a valid email address.");
      return;
    }
    if (admins.some((admin) => admin.email === value)) {
      setError("That admin already exists.");
      return;
    }
    setAdmins((items) => [
      ...items,
      {
        id: `a-${Date.now()}`,
        email: value,
        role,
        mfa: false,
        status: "invited",
        created: "just now",
      },
    ]);
    pushToast(`Invite sent to ${value}`);
    setInviteOpen(false);
    setEmail("");
    setRole("admin");
  }

  function resetMfa(admin: Admin) {
    setAdmins((items) =>
      items.map((item) =>
        item.id === admin.id ? { ...item, mfa: false } : item,
      ),
    );
    pushToast(`MFA reset for ${admin.email}`, "info");
  }

  return (
    <div>
      <PageHeader
        title="Admins"
        description="People who operate this console, separate from VPN users. VPN users live under VPN Users and only receive tunnel configs."
        actions={
          <PrimaryButton onClick={() => setInviteOpen(true)}>
            <IconUserPlus size={16} stroke={1.6} aria-hidden="true" />
            Invite Admin
          </PrimaryButton>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className={tabGroupCls}>
          {(["all", "active", "disabled"] as const).map((value) => {
            const count =
              value === "all"
                ? admins.length
                : admins.filter((admin) => admin.status === value).length;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={toolbarTab(
                  tab === value,
                  "bg-zinc-700 text-white",
                )}
              >
                {value === "all"
                  ? "All"
                  : value[0].toUpperCase() + value.slice(1)}
                <span className="ml-1 text-dim">{count}</span>
              </button>
            );
          })}
        </div>

        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <IconSearch
            size={14}
            stroke={1.7}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim"
            aria-hidden="true"
          />
          <input
            id="admin-search"
            name="adminSearch"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search email…"
            aria-label="Search admins"
            className={`${inputCls} py-1.5 pl-8`}
          />
        </div>

        <span className="ml-auto font-mono text-xs tabular-nums text-dim">
          {filtered.length} shown
        </span>
      </div>

      <div className={tableWrapCls}>
        {filtered.length === 0 ? (
          <EmptyState
            title="No admins match this filter"
            hint="Adjust the filter or invite a new admin."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-dim">
                  <th className={thCls}>Email</th>
                  <th className={thCls}>Role</th>
                  <th className={thCls}>MFA</th>
                  <th className={thCls}>Status</th>
                  <th className={thCls}>Created</th>
                  <th className={thCls + " text-right"}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {filtered.map((admin) => (
                  <tr
                    key={admin.id}
                    className="transition-colors hover:bg-zinc-800/30"
                  >
                    <td className="whitespace-nowrap px-5 py-3.5 text-sm text-zinc-200">
                      {admin.email}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5">
                      <Badge
                        tone={
                          admin.role === "super_admin"
                            ? "accent"
                            : admin.role === "admin"
                              ? "good"
                              : "neutral"
                        }
                      >
                        {ROLE_LABEL[admin.role]}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5">
                      <Badge tone={admin.mfa ? "good" : "warn"}>
                        {admin.mfa ? "enabled" : "not set up"}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5">
                      <StatusBadge status={admin.status} />
                    </td>
                    <td className={tdCls + " font-mono tabular-nums"}>
                      {admin.created}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5 text-right">
                      <ActionLink
                        tone="accent"
                        onClick={() => resetMfa(admin)}
                      >
                        <IconKey size={14} stroke={1.6} aria-hidden="true" />
                        Reset MFA
                      </ActionLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite Admin"
        className="max-w-md"
        footer={
          <>
            <GhostButton onClick={() => setInviteOpen(false)}>Cancel</GhostButton>
            <PrimaryButton type="submit" form="invite-admin-form">
              Send Invite
            </PrimaryButton>
          </>
        }
      >
        <form id="invite-admin-form" onSubmit={invite} className="space-y-4">
          <Field label="Email" htmlFor="admin-email" error={error}>
            <input
              id="admin-email"
              data-autofocus
              type="email"
              required
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                if (error) setError("");
              }}
              placeholder="operator@company.com"
              className={inputCls}
            />
          </Field>
          <Field label="Role" htmlFor="admin-role">
            <select
              id="admin-role"
              value={role}
              onChange={(event) =>
                setRole(event.target.value as Admin["role"])
              }
              className={selectCls}
            >
              <option value="admin">
                Admin, manage users, peers, servers
              </option>
              <option value="super_admin">Super admin, everything</option>
              <option value="auditor">Auditor, read-only</option>
            </select>
          </Field>
          <p className="text-xs leading-relaxed text-dim">
            The invited admin receives temporary credentials by email and must
            change them in Profile on first login. MFA is enforced.
          </p>
        </form>
      </Modal>
    </div>
  );
}
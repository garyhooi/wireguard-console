"use client";

import { useEffect, useState } from "react";
import {
  IconBan,
  IconBuilding,
  IconChartBar,
  IconDeviceDesktop,
  IconDots,
  IconExternalLink,
  IconGauge,
  IconHistory,
  IconHome2,
  IconLayoutDashboard,
  IconLogout,
  IconMenu2,
  IconPackage,
  IconRefresh,
  IconServer,
  IconShieldCheck,
  IconShieldLock,
  IconUserShield,
  IconUsers,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import { BrandMark } from "@/components/brand";
import { AmbientBackdrop } from "@/components/demo/ambient-backdrop";
import { GithubCorner } from "@/components/demo/github-corner";
import { DemoProvider, useDemo, type DemoView } from "@/components/demo/store";
import { LoginScreen } from "@/components/demo/login";
import { SignOutOverlay } from "@/components/demo/sign-out-overlay";
import { ToastRegion } from "@/components/demo/ui";
import { DashboardView } from "@/components/demo/views/dashboard";
import { ServersView } from "@/components/demo/views/servers";
import { PeersView } from "@/components/demo/views/peers";
import { NodesView } from "@/components/demo/views/nodes";
import { UsersView } from "@/components/demo/views/users";
import { DomainRulesView } from "@/components/demo/views/domain-rules";
import { IpRulesView } from "@/components/demo/views/ip-rules";
import { AuditLogView } from "@/components/demo/views/audit-log";
import { StatisticsView } from "@/components/demo/views/statistics";
import { ServerMonitoringView } from "@/components/demo/views/server-monitoring";
import { WebActivityView } from "@/components/demo/views/web-activity";
import { DepartmentsView } from "@/components/demo/views/departments";
import { AdminsView } from "@/components/demo/views/admins";
import { BackupsView } from "@/components/demo/views/backups";
import { ConfigurationView } from "@/components/demo/views/configuration";
import { ProfileView } from "@/components/demo/views/profile";
import {
  AddNodeDialog,
  IssuePeerDialog,
  PeerConfigDialog,
  RevokePeerDialog,
} from "@/components/demo/dialogs";
import { cn } from "@/lib/cn";

type NavIcon = typeof IconLayoutDashboard;

type NavGroup = {
  group: string;
  items: Array<{ view: DemoView; label: string; icon: NavIcon }>;
};

const NAV_GROUPS: NavGroup[] = [
  {
    group: "Monitoring",
    items: [
      { view: "dashboard", label: "Dashboard", icon: IconLayoutDashboard },
      { view: "statistics", label: "Statistics", icon: IconChartBar },
      { view: "server-monitoring", label: "Server Monitoring", icon: IconGauge },
      { view: "web-activity", label: "Web Activity", icon: IconWorld },
      { view: "audit-log", label: "Audit Log", icon: IconHistory },
    ],
  },
  {
    group: "Network",
    items: [
      { view: "servers", label: "Servers", icon: IconServer },
      { view: "peers", label: "Peers", icon: IconDeviceDesktop },
      { view: "nodes", label: "Nodes", icon: IconDots },
    ],
  },
  {
    group: "Directory",
    items: [
      { view: "users", label: "VPN Users", icon: IconUsers },
      { view: "departments", label: "Departments", icon: IconBuilding },
      { view: "admins", label: "Admins", icon: IconUserShield },
    ],
  },
  {
    group: "Security",
    items: [
      { view: "domain-rules", label: "Domain Blocking", icon: IconShieldCheck },
      { view: "ip-rules", label: "IP Blocking", icon: IconBan },
    ],
  },
  {
    group: "System",
    items: [
      { view: "backups", label: "Backups", icon: IconShieldLock },
      { view: "configuration", label: "Configuration", icon: IconShieldLock },
      { view: "profile", label: "Profile", icon: IconHome2 },
    ],
  },
];

const VIEW_META = NAV_GROUPS.flatMap((group) =>
  group.items.map((item) => ({ ...item, group: group.group })),
).reduce<Record<DemoView, { label: string; group: string }>>(
  (acc, item) => {
    acc[item.view] = { label: item.label, group: item.group };
    return acc;
  },
  {} as Record<DemoView, { label: string; group: string }>,
);

function NavButton({
  item,
  active,
  onSelect,
}: {
  item: { view: DemoView; label: string; icon: NavIcon };
  active: boolean;
  onSelect: (view: DemoView) => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(item.view)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md border border-transparent px-3 py-1 text-left text-sm text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-100",
        active && "border-teal-500/20 bg-teal-500/10 text-teal-400",
      )}
    >
      <Icon size={16} stroke={1.6} className="shrink-0 opacity-80" aria-hidden="true" />
      {item.label}
    </button>
  );
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const {
    view,
    setView,
    resetDemo,
    peers,
    regions,
    toasts,
    dismissToast,
  } = useDemo();
  const [mobileOpen, setMobileOpen] = useState(false);

  const current = VIEW_META[view] ?? { label: "Dashboard", group: "Monitoring" };
  const consoleUrl = process.env.NEXT_PUBLIC_CONSOLE_URL;
  const connected = peers.filter(
    (peer) => peer.status === "active" && peer.lastHandshake !== "never",
  ).length;

  useEffect(() => {
    setMobileOpen(false);
  }, [view]);

  useEffect(() => {
    if (!mobileOpen) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = original;
    };
  }, [mobileOpen]);

  function select(next: DemoView) {
    setView(next);
    setMobileOpen(false);
  }

  function reset() {
    resetDemo();
    setMobileOpen(false);
  }

  const nav = (onSelect: (next: DemoView) => void) => (
    <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
      {NAV_GROUPS.map((group) => (
        <div key={group.group}>
          <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-dim">
            {group.group}
          </p>
          <div className="space-y-0.5">
            {group.items.map((item) => (
              <NavButton
                key={item.view}
                item={item}
                active={view === item.view}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-[100dvh] bg-zinc-950">
      <aside className="sticky top-0 hidden h-[100dvh] w-60 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950 lg:flex">
        <div className="flex h-16 items-center gap-2.5 border-b border-zinc-800/80 px-5">
          <BrandMark />
          <span className="font-semibold tracking-tight text-white">
            WireGuard Console
          </span>
        </div>

        {nav(select)}

        <div className="space-y-3 border-t border-zinc-800/80 px-5 py-4">
          {consoleUrl && (
            <a
              href={consoleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-teal-400 transition-colors hover:text-teal-300"
            >
              <IconExternalLink size={13} stroke={1.7} aria-hidden="true" />
              Open real console
            </a>
          )}
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1.5 text-xs text-dim transition-colors hover:text-zinc-300"
          >
            <IconRefresh size={13} stroke={1.7} aria-hidden="true" />
            Reset demo
          </button>
          <div className="flex items-center justify-between text-xs text-dim">
            <span>Peers</span>
            <span className="font-mono tabular-nums">
              {connected} / {peers.length}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs text-dim">
            <span>Servers</span>
            <span className="font-mono tabular-nums">{regions.length}</span>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="inline-flex items-center gap-1.5 text-xs text-dim transition-colors hover:text-red-400"
          >
            <IconLogout size={13} stroke={1.7} aria-hidden="true" />
            Sign out
          </button>
        </div>
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <AmbientBackdrop />

        <header className="sticky top-0 z-30 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6 lg:px-8">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
              aria-expanded={mobileOpen}
              className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-100 lg:hidden"
            >
              <IconMenu2 size={18} stroke={1.7} />
            </button>
            <span className="text-sm font-semibold tracking-tight text-white lg:hidden">
              WireGuard Console
            </span>

            <div className="hidden items-center gap-2 text-xs text-dim lg:flex">
              <span className="text-dim">{current.group}</span>
              <span className="text-dim">/</span>
              <span className="font-medium text-zinc-300">{current.label}</span>
            </div>

            <div className="ml-auto flex items-center gap-3">
              <span className="hidden items-center gap-1.5 text-xs text-dim md:inline-flex">
                <IconPackage size={13} stroke={1.7} aria-hidden="true" />
                <span className="font-mono tabular-nums">v1.2.0</span>
              </span>
              <span className="hidden items-center gap-1.5 text-xs text-dim sm:inline-flex">
                <span
                  className="h-1.5 w-1.5 rounded-full bg-teal-400"
                  aria-hidden="true"
                />
                API
              </span>
              <button
                type="button"
                onClick={onSignOut}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-dim transition-colors hover:bg-zinc-800/60 hover:text-zinc-200 lg:hidden"
              >
                <IconLogout size={13} stroke={1.7} aria-hidden="true" />
                Sign out
              </button>
            </div>
          </div>
        </header>

        {mobileOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-zinc-950/70 backdrop-blur-sm"
              onClick={() => setMobileOpen(false)}
            />
            <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-zinc-800 bg-zinc-950">
              <div className="flex h-16 items-center justify-between border-b border-zinc-800/80 px-4">
                <div className="flex items-center gap-2.5">
                  <BrandMark />
                  <span className="text-sm font-semibold tracking-tight text-white">
                    WireGuard Console
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setMobileOpen(false)}
                  aria-label="Close navigation"
                  className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-100"
                >
                  <IconX size={18} stroke={1.7} />
                </button>
              </div>

              {nav(select)}

              <div className="space-y-3 border-t border-zinc-800/80 px-5 py-4">
                {consoleUrl && (
                  <a
                    href={consoleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-teal-400 transition-colors hover:text-teal-300"
                  >
                    <IconExternalLink size={13} stroke={1.7} aria-hidden="true" />
                    Open real console
                  </a>
                )}
                <button
                  type="button"
                  onClick={reset}
                  className="flex items-center gap-1.5 text-xs text-dim transition-colors hover:text-zinc-300"
                >
                  <IconRefresh size={13} stroke={1.7} aria-hidden="true" />
                  Reset demo
                </button>
                <button
                  type="button"
                  onClick={onSignOut}
                  className="flex items-center gap-1.5 text-xs text-dim transition-colors hover:text-red-400"
                >
                  <IconLogout size={13} stroke={1.7} aria-hidden="true" />
                  Sign out
                </button>
              </div>
            </div>
          </div>
        )}

        <main
          key={view}
          className="demo-panel-in relative z-10 mx-auto w-full max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8"
        >
          {view === "dashboard" && <DashboardView />}
          {view === "statistics" && <StatisticsView />}
          {view === "server-monitoring" && <ServerMonitoringView />}
          {view === "web-activity" && <WebActivityView />}
          {view === "audit-log" && <AuditLogView />}
          {view === "servers" && <ServersView />}
          {view === "peers" && <PeersView />}
          {view === "nodes" && <NodesView />}
          {view === "users" && <UsersView />}
          {view === "departments" && <DepartmentsView />}
          {view === "admins" && <AdminsView />}
          {view === "domain-rules" && <DomainRulesView />}
          {view === "ip-rules" && <IpRulesView />}
          {view === "backups" && <BackupsView />}
          {view === "configuration" && <ConfigurationView />}
          {view === "profile" && <ProfileView />}
        </main>
      </div>

      <GithubCorner />
      <ToastRegion toasts={toasts} onDismiss={dismissToast} />

      <IssuePeerDialog />
      <AddNodeDialog />
      <PeerConfigDialog />
      <RevokePeerDialog />
    </div>
  );
}

export function ConsoleDemo() {
  const [signedIn, setSignedIn] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  if (!signedIn) {
    return <LoginScreen onSignIn={() => setSignedIn(true)} />;
  }

  return (
    <>
      <DemoProvider>
        <Shell onSignOut={() => setSigningOut(true)} />
      </DemoProvider>
      {signingOut && (
        <SignOutOverlay
          onDone={() => {
            setSigningOut(false);
            setSignedIn(false);
          }}
        />
      )}
    </>
  );
}
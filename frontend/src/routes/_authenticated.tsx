import { createFileRoute, Link, Outlet, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  IconChartBar,
  IconDeviceDesktop,
  IconDots,
  IconGauge,
  IconHistory,
  IconHome2,
  IconLayoutDashboard,
  IconLogout,
  IconMenu2,
  IconServer,
  IconShieldCheck,
  IconShieldLock,
  IconUsers,
  IconUserShield,
  IconWorld,
  IconX,
} from '@tabler/icons-react'
import { apiFetch, clearSessionCache, fetchSession } from '../lib/api'
import { ensureTimezone } from '../lib/timezone'
import { ConsoleVersionControl } from '../components/ConsoleVersionControl'

interface Stats {
  total_peers: number
  active_peers: number
  total_users: number
  total_servers: number
  connected_peers: number
}

export const Route = createFileRoute('/_authenticated')({
  component: AuthenticatedLayout,
  beforeLoad: async () => {
    // The session lives in an HttpOnly cookie; the only authoritative check
    // is a server probe. fetchSession() caches the result and sets the
    // in-memory CSRF token from /admins/me on this page load.
    const session = await fetchSession()
    if (!session) {
      throw redirect({ to: '/login' })
    }
    // Resolve the admin-configured console timezone (Configuration →
    // Timezone) before the first authed page renders so every timestamp is
    // formatted in the chosen zone. Unset → viewer's browser zone.
    await ensureTimezone()
  },
})

type Icon = React.ComponentType<{ size?: number; stroke?: number; className?: string }>

const NAV: NavGroup[] = [
  {
    group: 'Monitoring',
    items: [
      { label: 'Dashboard', to: '/dashboard', icon: IconLayoutDashboard },
      { label: 'Statistics', to: '/statistics', icon: IconChartBar },
      { label: 'Server Monitoring', to: '/monitoring', icon: IconGauge },
      { label: 'Web Activity', to: '/web-activity', icon: IconWorld },
      { label: 'Audit Log', to: '/audit-log', icon: IconHistory },
    ],
  },
  {
    group: 'Network',
    items: [
      { label: 'Servers', to: '/servers', icon: IconServer },
      { label: 'Peers', to: '/peers', icon: IconDeviceDesktop },
      { label: 'Nodes', to: '/nodes', icon: IconDots },
    ],
  },
  {
    group: 'Directory',
    items: [
      { label: 'VPN Users', to: '/users', icon: IconUsers },
      { label: 'Admins', to: '/admins', icon: IconUserShield },
    ],
  },
  {
    group: 'Security',
    items: [{ label: 'Domain Rules', to: '/domain-rules', icon: IconShieldCheck }],
  },
  {
    group: 'System',
    items: [
      { label: 'Backups', to: '/backups', icon: IconShieldLock },
      { label: 'Configuration', to: '/config', icon: IconShieldLock },
      { label: 'Profile', to: '/profile', icon: IconHome2 },
    ],
  },
]

type NavEntry = { label: string; to: string; icon: Icon }
type NavGroup = { group: string; items: NavEntry[] }

function NavLink({
  item,
  onNavigate,
}: {
  item: NavEntry
  onNavigate?: () => void
}) {
  const Icon = item.icon
  return (
    <Link
      to={item.to as never}
      onClick={onNavigate}
      activeOptions={{ exact: item.to === '/dashboard' }}
      activeProps={{ className: 'active' }}
      className="flex items-center gap-2.5 px-3 py-1.5 rounded-md text-sm text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 transition-colors [&.active]:text-teal-400 [&.active]:bg-teal-500/10 [&.active]:border [&.active]:border-teal-500/20"
    >
      <Icon size={16} stroke={1.6} className="shrink-0 opacity-80" aria-hidden="true" />
      {item.label}
    </Link>
  )
}

function AuthenticatedLayout() {
  const [mobileNav, setMobileNav] = useState(false)
  const { data: stats } = useQuery<Stats>({
    queryKey: ['stats'],
    queryFn: async () => {
      const res = await apiFetch('/api/stats/overview')
      if (!res.ok) throw new Error('Failed to fetch stats')
      return res.json()
    },
    refetchInterval: 15000,
  })

  // Server-side logout: revoke the session row (kills the token everywhere)
  // then clear the in-memory cache. The HttpOnly cookie is cleared by the
  // server's response; no localStorage token exists to remove.
  const logout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' })
    } catch {
      // Even if the network call fails we must still leave the authed shell.
    }
    clearSessionCache()
    window.location.href = '/login'
  }

  const currentPath = window.location.pathname
  const flat = NAV.flatMap((g) => g.items)
  const current = flat.find((i) => i.to === currentPath)
  const currentGroup = NAV.find((g) => g.items.some((i) => i.to === currentPath))?.group
  const currentLabel = current?.label

  return (
    <div className="min-h-[100dvh] bg-zinc-950 flex">
      {/* Sidebar (lg+) */}
      <aside className="hidden lg:flex flex-col w-60 shrink-0 border-r border-zinc-800/80 bg-zinc-950 sticky top-0 h-[100dvh]">
        <div className="px-5 h-16 flex items-center gap-2.5 border-b border-zinc-800/80">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-500/10 ring-1 ring-teal-500/20">
            <IconShieldLock size={18} stroke={1.6} className="text-teal-400" aria-hidden="true" />
          </span>
          <span className="text-white font-semibold tracking-tight">WireGuard Console</span>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
          {NAV.map((group) => (
            <div key={group.group}>
              <p className="px-3 mb-1.5 text-[11px] uppercase tracking-wider text-zinc-600 font-medium">
                {group.group}
              </p>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavLink key={item.to} item={item} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="px-5 py-4 border-t border-zinc-800/80 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500">Peers</span>
            <span className="text-zinc-300 font-mono tabular-nums">
              {stats?.connected_peers ?? '–'}
              <span className="text-zinc-600"> / {stats?.total_peers ?? '–'}</span>
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500">Servers</span>
            <span className="text-zinc-300 font-mono tabular-nums">{stats?.total_servers ?? '–'}</span>
          </div>
          <button
            onClick={logout}
            className="w-full flex items-center gap-2 text-left text-xs text-zinc-500 hover:text-red-400 transition-colors py-1"
          >
            <IconLogout size={14} stroke={1.6} aria-hidden="true" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex-1 min-w-0">
        {/* Top bar */}
        <header className="sticky top-0 z-30 bg-zinc-950/90 backdrop-blur border-b border-zinc-800/80">
          <div className="px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 shrink-0 lg:hidden">
              <button
                onClick={() => setMobileNav(!mobileNav)}
                className="text-zinc-300 hover:text-white transition-colors"
                aria-label="Toggle menu"
              >
                {mobileNav ? <IconX size={22} /> : <IconMenu2 size={22} />}
              </button>
              <span className="text-white font-semibold tracking-tight text-sm">WireGuard Console</span>
            </div>

            {/* Desktop: contextual path (breadcrumb-ish) */}
            <div className="hidden lg:flex items-center gap-2 text-xs text-zinc-600">
              {currentGroup && (
                <>
                  <span className="text-zinc-500">{currentGroup}</span>
                  <span className="text-zinc-700">/</span>
                  <span className="text-zinc-300 font-medium">{currentLabel}</span>
                </>
              )}
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <ConsoleVersionControl />
              <span
                className="hidden sm:inline-flex items-center gap-1.5 text-xs text-zinc-500"
                title="API availability"
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    stats ? 'bg-teal-400' : 'bg-zinc-600 animate-pulse'
                  }`}
                />
                API
              </span>
              <button
                onClick={logout}
                className="lg:hidden inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-red-400 transition-colors"
              >
                <IconLogout size={14} stroke={1.6} aria-hidden="true" />
                Sign out
              </button>
            </div>
          </div>
        </header>

        {/* Mobile grouped drawer */}
        {mobileNav && (
          <div className="lg:hidden bg-zinc-900 border-b border-zinc-800">
            <nav className="px-4 py-3 space-y-4 max-h-[70dvh] overflow-y-auto">
              {NAV.map((group) => (
                <div key={group.group}>
                  <p className="text-[11px] uppercase tracking-wider text-zinc-600 font-medium mb-1 px-2">
                    {group.group}
                  </p>
                  <div className="space-y-0.5">
                    {group.items.map((item) => (
                      <NavLink key={item.to} item={item} onNavigate={() => setMobileNav(false)} />
                    ))}
                  </div>
                </div>
              ))}
            </nav>
          </div>
        )}

        <main className="px-4 sm:px-6 lg:px-8 py-8 max-w-[1400px] mx-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

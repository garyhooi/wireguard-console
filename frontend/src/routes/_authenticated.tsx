import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

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
    const token = localStorage.getItem('token')
    if (!token) {
      window.location.href = '/login'
    }
  },
})

const NAV: NavGroup[] = [
  {
    group: 'Monitoring',
    items: [
      { label: 'Dashboard', to: '/dashboard' },
      { label: 'Statistics', to: '/statistics' },
      { label: 'Audit Log', to: '/audit-log' },
    ],
  },
  {
    group: 'Network',
    items: [
      { label: 'Servers', to: '/servers' },
      { label: 'Peers', to: '/peers' },
      { label: 'Nodes', to: '/nodes' },
    ],
  },
  {
    group: 'Directory',
    items: [
      { label: 'VPN Users', to: '/users' },
      { label: 'Admins', to: '/admins' },
    ],
  },
  {
    group: 'Security',
    items: [{ label: 'Domain Rules', to: '/domain-rules' }],
  },
  {
    group: 'System',
    items: [
      { label: 'Backups', to: '/backups' },
      { label: 'Configuration', to: '/config' },
      { label: 'Profile', to: '/profile' },
    ],
  },
]

type NavEntry = { label: string; to: string }
type NavGroup = { group: string; items: NavEntry[] }

function AuthenticatedLayout() {
  const [mobileNav, setMobileNav] = useState(false)
  const { data: stats } = useQuery<Stats>({
    queryKey: ['stats'],
    queryFn: async () => {
      const res = await fetch('/api/stats/overview', {
        headers: { Authorization: localStorage.getItem('token')! },
      })
      if (!res.ok) {
        if (res.status === 401) {
          localStorage.removeItem('token')
          window.location.href = '/login'
        }
        throw new Error('Failed to fetch stats')
      }
      return res.json()
    },
    refetchInterval: 15000,
  })

  const logout = () => {
    localStorage.removeItem('token')
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
        <div className="px-5 h-16 flex items-center border-b border-zinc-800/80">
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
                  <Link
                    key={item.to}
                    to={item.to as never}
                    activeOptions={{ exact: item.to === '/dashboard' }}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 transition-colors [&.active]:text-teal-400 [&.active]:bg-teal-500/10 [&.active]:border [&.active]:border-teal-500/20"
                    activeProps={{ className: 'active' }}
                  >
                    {item.label}
                  </Link>
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
            className="w-full text-left text-xs text-zinc-600 hover:text-red-400 transition-colors py-1"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex-1 min-w-0">
        {/* Top bar */}
        <header className="sticky top-0 z-30 bg-zinc-950/90 backdrop-blur border-b border-zinc-800/80">
          <div className="px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
            <span className="lg:hidden text-white font-semibold tracking-tight text-sm">
              WireGuard Console
            </span>

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
              <a
                href="https://github.com/garyhooi/wireguard-console"
                target="_blank"
                rel="noopener noreferrer"
                title="Source on GitHub"
                className="hidden sm:inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
              >
                <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                </svg>
                GitHub
              </a>
              <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-zinc-500">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    stats ? 'bg-teal-400' : 'bg-zinc-600 animate-pulse'
                  }`}
                />
                API
              </span>
              <button
                onClick={logout}
                className="lg:hidden text-xs text-zinc-600 hover:text-red-400 transition-colors"
              >
                Sign out
              </button>
              {/* Mobile: hamburger -> grouped drawer */}
              <button
                onClick={() => setMobileNav(!mobileNav)}
                className="lg:hidden text-zinc-300 hover:text-white text-xl leading-none"
                aria-label="Toggle menu"
              >
                ☰
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
                      <Link
                        key={item.to}
                        to={item.to as never}
                        onClick={() => setMobileNav(false)}
                        className="block px-3 py-2 rounded-md text-sm text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 [&.active]:text-teal-400 [&.active]:bg-teal-500/10"
                        activeOptions={{ exact: item.to === '/dashboard' }}
                        activeProps={{ className: 'active' }}
                      >
                        {item.label}
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
              <a
                href="https://github.com/garyhooi/wireguard-console"
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setMobileNav(false)}
                className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
              >
                <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                </svg>
                GitHub
              </a>
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
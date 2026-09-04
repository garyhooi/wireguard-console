import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
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
    group: 'Overview',
    items: [
      { label: 'Dashboard', to: '/dashboard' },
      { label: 'Statistics', to: '/statistics' },
      { label: 'Audit Log', to: '/audit-log' },
    ],
  },
  {
    group: 'Manage',
    items: [
      { label: 'Servers', to: '/servers' },
      { label: 'Peers', to: '/peers' },
      { label: 'Users', to: '/users' },
      { label: 'Nodes', to: '/nodes' },
    ],
  },
  {
    group: 'Guarding',
    items: [{ label: 'Domain Rules', to: '/domain-rules' }],
  },
  {
    group: 'System',
    items: [
      { label: 'Configuration', to: '/config' },
      { label: 'Profile', to: '/profile' },
    ],
  },
]

type NavEntry = { label: string; to: string }
type NavGroup = { group: string; items: NavEntry[] }

function AuthenticatedLayout() {
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
            <nav className="flex items-center gap-1 overflow-x-auto no-scrollbar">
              {NAV.flatMap((g) => g.items).map((item) => (
                <Link
                  key={item.to}
                  to={item.to as never}
                  activeOptions={{ exact: item.to === '/dashboard' }}
                  className="px-3 py-1.5 whitespace-nowrap rounded-md text-xs font-medium text-zinc-400 hover:text-zinc-100 transition-colors [&.active]:text-teal-400 [&.active]:bg-teal-500/10"
                  activeProps={{ className: 'active' }}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="flex items-center gap-3 shrink-0">
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
            </div>
          </div>
        </header>

        <main className="px-4 sm:px-6 lg:px-8 py-8 max-w-[1400px] mx-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
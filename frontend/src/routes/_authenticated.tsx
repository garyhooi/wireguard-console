import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

interface Stats {
  total_peers: number
  active_peers: number
  suspended_peers: number
  total_users: number
  active_users: number
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

  return (
    <div className="min-h-screen bg-neutral-950">
      <nav className="bg-neutral-900 border-b border-neutral-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center">
              <span className="text-white font-bold text-xl">WireGuard Console</span>
              <div className="ml-10 flex items-baseline space-x-4">
                <Link
                  to="/dashboard"
                  className="text-neutral-300 hover:text-white px-3 py-2 rounded-md text-sm font-medium"
                >
                  Dashboard
                </Link>
                <Link
                  to="/peers"
                  className="text-neutral-300 hover:text-white px-3 py-2 rounded-md text-sm font-medium"
                >
                  Peers
                </Link>
                <Link
                  to="/users"
                  className="text-neutral-300 hover:text-white px-3 py-2 rounded-md text-sm font-medium"
                >
                  Users
                </Link>
                <Link
                  to="/servers"
                  className="text-neutral-300 hover:text-white px-3 py-2 rounded-md text-sm font-medium"
                >
                  Servers
                </Link>
                <Link
                  to="/statistics"
                  className="text-neutral-300 hover:text-white px-3 py-2 rounded-md text-sm font-medium"
                >
                  Statistics
                </Link>
                <Link
                  to="/audit-log"
                  className="text-neutral-300 hover:text-white px-3 py-2 rounded-md text-sm font-medium"
                >
                  Audit Log
                </Link>
                <Link
                  to="/domain-rules"
                  className="text-neutral-300 hover:text-white px-3 py-2 rounded-md text-sm font-medium"
                >
                  Domain Rules
                </Link>
                <Link
                  to="/config"
                  className="text-neutral-300 hover:text-white px-3 py-2 rounded-md text-sm font-medium"
                >
                  Configuration
                </Link>
              </div>
            </div>
            <div className="flex items-center space-x-4">
              <Link
                to="/2fa-setup"
                className="text-neutral-300 hover:text-white px-3 py-2 rounded-md text-sm font-medium"
              >
                Setup 2FA
              </Link>
              <button
                onClick={() => {
                  localStorage.removeItem('token')
                  window.location.href = '/login'
                }}
                className="text-neutral-300 hover:text-white px-3 py-2 rounded-md text-sm font-medium"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  )
}

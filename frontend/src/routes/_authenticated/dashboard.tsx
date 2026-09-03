import { createFileRoute } from '@tanstack/react-router'
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

export const Route = createFileRoute('/_authenticated/dashboard')({
  component: DashboardPage,
})

function DashboardPage() {
  const { data: stats, isLoading } = useQuery<Stats>({
    queryKey: ['stats'],
    queryFn: async () => {
      const res = await fetch('/api/stats/overview', {
        headers: { Authorization: localStorage.getItem('token')! },
      })
      if (!res.ok) throw new Error('Failed to fetch stats')
      return res.json()
    },
    refetchInterval: 15000,
  })

  if (isLoading) {
    return <div className="text-neutral-400">Loading...</div>
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
          <h3 className="text-neutral-400 text-sm font-medium">Total Peers</h3>
          <p className="mt-2 text-3xl font-bold text-white">{stats?.total_peers || 0}</p>
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
          <h3 className="text-neutral-400 text-sm font-medium">Active Peers</h3>
          <p className="mt-2 text-3xl font-bold text-teal-500">{stats?.active_peers || 0}</p>
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
          <h3 className="text-neutral-400 text-sm font-medium">Connected Peers</h3>
          <p className="mt-2 text-3xl font-bold text-green-500">{stats?.connected_peers || 0}</p>
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
          <h3 className="text-neutral-400 text-sm font-medium">Total Users</h3>
          <p className="mt-2 text-3xl font-bold text-white">{stats?.total_users || 0}</p>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
          <h3 className="text-neutral-400 text-sm font-medium">Suspended Peers</h3>
          <p className="mt-2 text-3xl font-bold text-yellow-500">{stats?.suspended_peers || 0}</p>
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
          <h3 className="text-neutral-400 text-sm font-medium">Active Users</h3>
          <p className="mt-2 text-3xl font-bold text-white">{stats?.active_users || 0}</p>
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
          <h3 className="text-neutral-400 text-sm font-medium">Servers</h3>
          <p className="mt-2 text-3xl font-bold text-white">{stats?.total_servers || 0}</p>
        </div>
      </div>
    </div>
  )
}

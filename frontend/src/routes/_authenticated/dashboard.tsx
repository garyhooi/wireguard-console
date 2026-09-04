import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { EmptyState, PageHeader, Panel, Skeleton, Stat, StatusBadge } from '../../lib/ui'

interface Stats {
  total_peers: number
  active_peers: number
  suspended_peers: number
  total_users: number
  active_users: number
  total_servers: number
  connected_peers: number
}

interface Peer {
  id: string
  name: string
  allowed_ip: string
  status: string
  last_handshake_at: string | null
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

  const { data: peers } = useQuery<Peer[]>({
    queryKey: ['peers'],
    queryFn: async () => {
      const res = await fetch('/api/peers', {
        headers: { Authorization: localStorage.getItem('token')! },
      })
      if (!res.ok) throw new Error('Failed to fetch peers')
      return res.json()
    },
    refetchInterval: 15000,
  })

  const activePeers = (peers || []).filter((p) => p.status !== 'removed').slice(0, 8)

  if (isLoading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-8 w-56" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-zinc-800 rounded-lg overflow-hidden">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-zinc-900 p-5 space-y-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-7 w-20" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Live state of your WireGuard mesh: peers, users and nodes across every managed server."
      />

      {/* KPI band — bordered cells in one panel, no floating cards */}
      <Panel>
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-zinc-800">
          <Stat label="Peers" value={stats?.total_peers ?? 0} sub="total issued" />
          <Stat
            label="Connected"
            value={stats?.connected_peers ?? 0}
            tone={(stats?.connected_peers ?? 0) > 0 ? 'good' : 'default'}
            sub="live handshakes"
          />
          <Stat
            label="Suspended"
            value={stats?.suspended_peers ?? 0}
            tone={(stats?.suspended_peers ?? 0) > 0 ? 'warn' : 'default'}
            sub="of active configs"
          />
          <Stat label="Users" value={stats?.total_users ?? 0} sub="with VPN access" />
        </div>
        <div className="border-t border-zinc-800 grid grid-cols-2 lg:grid-cols-3 divide-x divide-y lg:divide-y-0 divide-zinc-800">
          <Stat label="Servers" value={stats?.total_servers ?? 0} sub="managed" />
          <Stat label="Active users" value={stats?.total_users ?? 0} sub="activated" />
          <Stat label="Active peers" value={stats?.active_peers ?? 0} tone="good" sub="enabled" />
        </div>
      </Panel>

      {/* Recent peers */}
      <div className="mt-8">
        <Panel title="Recent peers" right={<Link to="/peers" className="text-xs text-teal-400 hover:text-teal-300">View all →</Link>}>
          {activePeers.length === 0 ? (
            <EmptyState
              title="No peers yet"
              hint="Create a server, invite a user, then add a peer — the tunnel config is generated automatically."
              action={
                <Link
                  to="/peers"
                  className="inline-flex items-center bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium py-2 px-4 rounded-md"
                >
                  Add peer
                </Link>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-zinc-800/80">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-600">
                    <th className="px-5 py-2.5 font-medium">Peer</th>
                    <th className="px-5 py-2.5 font-medium">Tunnel IP</th>
                    <th className="px-5 py-2.5 font-medium">Status</th>
                    <th className="px-5 py-2.5 font-medium">Last handshake</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {activePeers.map((peer) => (
                    <tr key={peer.id} className="hover:bg-zinc-800/40 transition-colors">
                      <td className="px-5 py-3 text-sm text-zinc-200">{peer.name}</td>
                      <td className="px-5 py-3 text-sm text-zinc-500 font-mono">{peer.allowed_ip}</td>
                      <td className="px-5 py-3">
                        <StatusBadge status={peer.status} />
                      </td>
                      <td className="px-5 py-3 text-sm text-zinc-500 font-mono tabular-nums">
                        {peer.last_handshake_at
                          ? new Date(peer.last_handshake_at).toLocaleString()
                          : 'Never'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}
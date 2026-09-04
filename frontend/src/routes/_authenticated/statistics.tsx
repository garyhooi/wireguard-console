import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { EmptyState, PageHeader, Panel, Skeleton, Stat, StatusBadge } from '../../lib/ui'

interface Overview {
  total_rx_bytes: number
  total_tx_bytes: number
  connected_peers: number
  total_peers: number
}

interface TrafficResponse {
  series: { time: string; rx: number; tx: number }[]
  top: { name: string; rx: number; tx: number }[]
}

interface Peer {
  id: string
  name: string
  allowed_ip: string
  status: string
  last_handshake_at: string | null
}

export const Route = createFileRoute('/_authenticated/statistics')({
  component: StatisticsPage,
})

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

const auth = { Authorization: localStorage.getItem('token')! }

const chartTooltipStyle = {
  backgroundColor: '#18181b',
  border: '1px solid #3f3f46',
  borderRadius: '6px',
  fontSize: '12px',
}

function StatisticsPage() {
  const { data: overview, isLoading } = useQuery<Overview>({
    queryKey: ['stats'],
    queryFn: async () => {
      const res = await fetch('/api/stats/overview', { headers: auth })
      if (!res.ok) throw new Error('Failed to fetch stats')
      return res.json()
    },
    refetchInterval: 15000,
  })

  const { data: traffic, isLoading: trafficLoading } = useQuery<TrafficResponse>({
    queryKey: ['stats-traffic'],
    queryFn: async () => {
      const res = await fetch('/api/stats/traffic', { headers: auth })
      if (!res.ok) throw new Error('Failed to fetch traffic')
      return res.json()
    },
    refetchInterval: 30000,
  })

  const { data: peers } = useQuery<Peer[]>({
    queryKey: ['peers'],
    queryFn: async () => {
      const res = await fetch('/api/peers', { headers: auth })
      if (!res.ok) throw new Error('Failed to fetch peers')
      return res.json()
    },
    refetchInterval: 15000,
  })

  if (isLoading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-8 w-56" />
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-px bg-zinc-800 rounded-lg overflow-hidden">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-zinc-900 p-5 space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-7 w-24" />
            </div>
          ))}
        </div>
        <Skeleton className="h-72 w-full rounded-lg" />
      </div>
    )
  }

  const hasTraffic = (traffic?.series?.length ?? 0) > 0

  return (
    <div>
      <PageHeader
        title="Statistics"
        description="Kernel-sampled traffic from every managed interface, aggregated hourly. Numbers refresh every 30 seconds."
      />

      {/* KPI band */}
      <Panel>
        <div className="grid grid-cols-2 lg:grid-cols-3 divide-x divide-y lg:divide-y-0 divide-zinc-800">
          <Stat label="Download · 24h" value={formatBytes(overview?.total_rx_bytes ?? 0)} tone="good" />
          <Stat label="Upload · 24h" value={formatBytes(overview?.total_tx_bytes ?? 0)} />
          <Stat
            label="Connected peers"
            value={overview?.connected_peers ?? 0}
            tone={(overview?.connected_peers ?? 0) > 0 ? 'good' : 'default'}
            sub={`of ${overview?.total_peers ?? 0} peers`}
          />
        </div>
      </Panel>

      {/* Charts */}
      <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel title="Traffic over time · last 24h">
          {trafficLoading ? (
            <div className="p-5">
              <Skeleton className="h-64 w-full" />
            </div>
          ) : hasTraffic ? (
            <div className="p-4">
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={traffic?.series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis dataKey="time" stroke="#71717a" tick={{ fontSize: 11 }} tickLine={false} />
                  <YAxis stroke="#71717a" tick={{ fontSize: 11 }} tickFormatter={formatBytes} tickLine={false} />
                  <Tooltip contentStyle={chartTooltipStyle} formatter={(v) => formatBytes(Number(v ?? 0))} />
                  <Area type="monotone" dataKey="rx" stroke="#14b8a6" fill="#14b8a6" fillOpacity={0.18} name="Download" strokeWidth={1.5} />
                  <Area type="monotone" dataKey="tx" stroke="#71717a" fill="#71717a" fillOpacity={0.14} name="Upload" strokeWidth={1.5} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyState
              title="No traffic sampled yet"
              hint="Counter deltas are captured every 30s from wg-helper once peers start passing traffic through the tunnel."
            />
          )}
        </Panel>

        <Panel title="Top peers by volume · last 24h">
          {trafficLoading ? (
            <div className="p-5">
              <Skeleton className="h-64 w-full" />
            </div>
          ) : (traffic?.top?.length ?? 0) > 0 ? (
            <div className="p-4">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={traffic?.top} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis
                    dataKey="name"
                    stroke="#71717a"
                    tick={{ fontSize: 10 }}
                    tickLine={false}
                    interval={0}
                  />
                  <YAxis stroke="#71717a" tick={{ fontSize: 11 }} tickFormatter={formatBytes} tickLine={false} />
                  <Tooltip contentStyle={chartTooltipStyle} formatter={(v) => formatBytes(Number(v ?? 0))} />
                  <Bar dataKey="rx" stackId="a" fill="#14b8a6" name="Download" />
                  <Bar dataKey="tx" stackId="a" fill="#52525b" name="Upload" />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyState
              title="No traffic yet"
              hint="Top peers appear here once sampled traffic accumulates."
            />
          )}
        </Panel>
      </div>

      {/* Peer detail table */}
      <div className="mt-8">
        <Panel title="Peer state">
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
                {(peers || [])
                  .filter((p) => p.status !== 'removed')
                  .map((peer) => (
                    <tr key={peer.id} className="hover:bg-zinc-800/40 transition-colors">
                      <td className="px-5 py-3 text-sm text-zinc-200">{peer.name}</td>
                      <td className="px-5 py-3 text-sm text-zinc-500 font-mono">{peer.allowed_ip}</td>
                      <td className="px-5 py-3">
                        <StatusBadge status={peer.status} />
                      </td>
                      <td className="px-5 py-3 text-sm text-zinc-500 font-mono tabular-nums">
                        {peer.last_handshake_at ? new Date(peer.last_handshake_at).toLocaleString() : 'Never'}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  )
}
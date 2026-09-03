import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend,
} from 'recharts'

interface TrafficSample {
  sampled_at: string
  rx_bytes: number
  tx_bytes: number
}

interface TrafficResponse {
  samples: TrafficSample[]
  total_rx_bytes: number
  total_tx_bytes: number
}

export const Route = createFileRoute('/_authenticated/statistics')({
  component: StatisticsPage,
})

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString()
}

function StatisticsPage() {
  const { data: overview } = useQuery({
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

  // Mock data for charts - in production, fetch from API
  const trafficData = [
    { time: '00:00', rx: 1024, tx: 2048 },
    { time: '04:00', rx: 512, tx: 1024 },
    { time: '08:00', rx: 4096, tx: 8192 },
    { time: '12:00', rx: 8192, tx: 16384 },
    { time: '16:00', rx: 6144, tx: 12288 },
    { time: '20:00', rx: 3072, tx: 6144 },
    { time: '24:00', rx: 2048, tx: 4096 },
  ]

  const topPeers = [
    { name: 'Device 1', rx: 1024000, tx: 2048000 },
    { name: 'Device 2', rx: 512000, tx: 1024000 },
    { name: 'Device 3', rx: 256000, tx: 512000 },
    { name: 'Device 4', rx: 128000, tx: 256000 },
    { name: 'Device 5', rx: 64000, tx: 128000 },
  ]

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">Statistics</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
          <h3 className="text-neutral-400 text-sm font-medium">Total RX Today</h3>
          <p className="mt-2 text-3xl font-bold text-teal-500">
            {formatBytes(overview?.total_rx_bytes || 0)}
          </p>
        </div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
          <h3 className="text-neutral-400 text-sm font-medium">Total TX Today</h3>
          <p className="mt-2 text-3xl font-bold text-blue-500">
            {formatBytes(overview?.total_tx_bytes || 0)}
          </p>
        </div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
          <h3 className="text-neutral-400 text-sm font-medium">Connected Peers</h3>
          <p className="mt-2 text-3xl font-bold text-green-500">
            {overview?.connected_peers || 0}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Traffic Over Time</h2>
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={trafficData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="time" stroke="#666" />
              <YAxis stroke="#666" tickFormatter={formatBytes} />
              <Tooltip 
                contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333' }}
                formatter={(value) => formatBytes(Number(value ?? 0))}
              />
              <Area 
                type="monotone" 
                dataKey="rx" 
                stroke="#0d9488" 
                fill="#0d9488" 
                fillOpacity={0.3}
                name="Download"
              />
              <Area 
                type="monotone" 
                dataKey="tx" 
                stroke="#3b82f6" 
                fill="#3b82f6" 
                fillOpacity={0.3}
                name="Upload"
              />
              <Legend />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Top Peers by Usage</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={topPeers}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="name" stroke="#666" />
              <YAxis stroke="#666" tickFormatter={formatBytes} />
              <Tooltip 
                contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333' }}
                formatter={(value) => formatBytes(Number(value ?? 0))}
              />
              <Bar dataKey="rx" stackId="a" fill="#0d9488" name="Download" />
              <Bar dataKey="tx" stackId="a" fill="#3b82f6" name="Upload" />
              <Legend />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Peer Details</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-neutral-800">
            <thead className="bg-neutral-800">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                  Peer
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                  Last Handshake
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-neutral-400 uppercase tracking-wider">
                  Download
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-neutral-400 uppercase tracking-wider">
                  Upload
                </th>
              </tr>
            </thead>
            <tbody className="bg-neutral-900 divide-y divide-neutral-800">
              <tr>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-white">Device 1</td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800">
                    Active
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400">2 min ago</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400 text-right">976.56 KB</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400 text-right">2 MB</td>
              </tr>
              <tr>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-white">Device 2</td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800">
                    Active
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400">5 min ago</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400 text-right">500 KB</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400 text-right">1 MB</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

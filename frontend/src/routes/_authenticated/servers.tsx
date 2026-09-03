import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

interface Server {
  id: string
  name: string
  public_endpoint: string
  listen_port: number
  interface_name: string
  server_public_key: string
  network_cidr: string
  status: string
  created_at: string
}

export const Route = createFileRoute('/_authenticated/servers')({
  component: ServersPage,
})

function ServersPage() {
  const queryClient = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    name: '',
    public_endpoint: '',
    interface_name: 'wg0',
    listen_port: '51820',
    network_cidr: '10.8.0.0/24',
    dns_servers: '1.1.1.1, 8.8.8.8',
    default_allowed_ips: '0.0.0.0/0, ::/0',
    mtu: '1420',
    persistent_keepalive: '25',
  })

  const { data: servers, isLoading } = useQuery<Server[]>({
    queryKey: ['servers'],
    queryFn: async () => {
      const res = await fetch('/api/servers', {
        headers: { Authorization: localStorage.getItem('token')! },
      })
      if (!res.ok) throw new Error('Failed to fetch servers')
      return res.json()
    },
  })

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/servers', {
        method: 'POST',
        headers: {
          Authorization: localStorage.getItem('token')!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: form.name,
          public_endpoint: form.public_endpoint,
          interface_name: form.interface_name,
          listen_port: Number(form.listen_port),
          network_cidr: form.network_cidr,
          dns_servers: form.dns_servers.split(',').map((s) => s.trim()).filter(Boolean),
          default_allowed_ips: form.default_allowed_ips,
          mtu: Number(form.mtu),
          persistent_keepalive: Number(form.persistent_keepalive),
        }),
      })
      if (!res.ok) throw new Error('Failed to create server')
      return res.json()
    },
    onSuccess: () => {
      setShowAdd(false)
      setError('')
      setForm({
        name: '',
        public_endpoint: '',
        interface_name: 'wg0',
        listen_port: '51820',
        network_cidr: '10.8.0.0/24',
        dns_servers: '1.1.1.1, 8.8.8.8',
        default_allowed_ips: '0.0.0.0/0, ::/0',
        mtu: '1420',
        persistent_keepalive: '25',
      })
      queryClient.invalidateQueries({ queryKey: ['servers'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  if (isLoading) {
    return <div className="text-neutral-400">Loading...</div>
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Servers</h1>
        <button
          onClick={() => setShowAdd(true)}
          className="bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md"
        >
          Add Server
        </button>
      </div>

      {showAdd && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6 max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-white mb-1">Add Server</h2>
            <p className="text-sm text-neutral-400 mb-4">
              A server is one WireGuard interface on the VPN host (like wg0). Keys are generated
              automatically.
            </p>
            {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
            <form
              onSubmit={(e) => {
                e.preventDefault()
                createMutation.mutate()
              }}
              className="space-y-4"
            >
              <div>
                <label htmlFor="sName" className="block text-sm font-medium text-neutral-400 mb-2">
                  Name
                </label>
                <input
                  id="sName"
                  required
                  value={form.name}
                  onChange={set('name')}
                  placeholder="e.g. Production VPN"
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <div>
                <label htmlFor="sEndp" className="block text-sm font-medium text-neutral-400 mb-2">
                  Public endpoint (host:port) — what peers connect to
                </label>
                <input
                  id="sEndp"
                  required
                  value={form.public_endpoint}
                  onChange={set('public_endpoint')}
                  placeholder="e.g. 15.232.201.12:51820"
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="sIface" className="block text-sm font-medium text-neutral-400 mb-2">
                    Interface name
                  </label>
                  <input
                    id="sIface"
                    value={form.interface_name}
                    onChange={set('interface_name')}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                </div>
                <div>
                  <label htmlFor="sPort" className="block text-sm font-medium text-neutral-400 mb-2">
                    Listen port
                  </label>
                  <input
                    id="sPort"
                    value={form.listen_port}
                    onChange={set('listen_port')}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="sCidr" className="block text-sm font-medium text-neutral-400 mb-2">
                  Network (peer IPs are allocated from this)
                </label>
                <input
                  id="sCidr"
                  value={form.network_cidr}
                  onChange={set('network_cidr')}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <div>
                <label htmlFor="sDns" className="block text-sm font-medium text-neutral-400 mb-2">
                  DNS servers (comma-separated)
                </label>
                <input
                  id="sDns"
                  value={form.dns_servers}
                  onChange={set('dns_servers')}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <div className="flex space-x-3">
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md disabled:opacity-50"
                >
                  {createMutation.isPending ? 'Creating...' : 'Create Server'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  className="bg-neutral-700 hover:bg-neutral-600 text-white font-medium py-2 px-4 rounded-md"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-neutral-800">
          <thead className="bg-neutral-800">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Endpoint
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Interface
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Network
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Public Key
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Status
              </th>
            </tr>
          </thead>
          <tbody className="bg-neutral-900 divide-y divide-neutral-800">
            {servers?.map((server) => (
              <tr key={server.id}>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-white">{server.name}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400 font-mono">
                  {server.public_endpoint}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400 font-mono">
                  {server.interface_name}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400 font-mono">
                  {server.network_cidr}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400 font-mono">
                  {server.server_public_key.substring(0, 16)}...
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span
                    className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                      server.status === 'active'
                        ? 'bg-green-100 text-green-800'
                        : 'bg-red-100 text-red-800'
                    }`}
                  >
                    {server.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
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
  dns_servers: string[]
  default_allowed_ips: string
  mtu: number
  persistent_keepalive: number
  managed_mode: string
  status: string
  created_at: string
}

export const Route = createFileRoute('/_authenticated/servers')({
  component: ServersPage,
})

const auth = { Authorization: localStorage.getItem('token')! }

const emptyForm = {
  name: '',
  public_endpoint: '',
  interface_name: 'wg0',
  listen_port: '51820',
  network_cidr: '10.8.0.0/24',
  dns_servers: '1.1.1.1, 8.8.8.8',
  default_allowed_ips: '0.0.0.0/0, ::/0',
  mtu: '1420',
  persistent_keepalive: '25',
  managed_mode: 'local',
}

function ServersPage() {
  const queryClient = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState<Server | null>(null)
  const [error, setError] = useState('')
  const [form, setForm] = useState(emptyForm)
  const [hostSetup, setHostSetup] = useState<{ name: string; text: string } | null>(null)
  const [hostCopied, setHostCopied] = useState(false)

  const { data: servers, isLoading } = useQuery<Server[]>({
    queryKey: ['servers'],
    queryFn: async () => {
      const res = await fetch('/api/servers', { headers: auth })
      if (!res.ok) throw new Error('Failed to fetch servers')
      return res.json()
    },
  })

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name,
        public_endpoint: form.public_endpoint,
        interface_name: form.interface_name,
        listen_port: Number(form.listen_port),
        network_cidr: form.network_cidr,
        dns_servers: form.dns_servers.split(',').map((s) => s.trim()).filter(Boolean),
        default_allowed_ips: form.default_allowed_ips,
        mtu: Number(form.mtu),
        persistent_keepalive: Number(form.persistent_keepalive),
        managed_mode: form.managed_mode,
      }
      const res = await fetch(editing ? `/api/servers/${editing.id}` : '/api/servers', {
        method: editing ? 'PATCH' : 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(editing ? 'Failed to update server' : 'Failed to create server')
      return res.json()
    },
    onSuccess: () => {
      setShowAdd(false)
      setEditing(null)
      setError('')
      setForm(emptyForm)
      queryClient.invalidateQueries({ queryKey: ['servers'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const removeMutation = useMutation({
    mutationFn: async (server: Server) => {
      const res = await fetch(`/api/servers/${server.id}`, {
        method: 'DELETE',
        headers: auth,
      })
      if (!res.ok) throw new Error('Failed to delete server')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['servers'] }),
    onError: (e: Error) => setError(e.message),
  })

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const openEdit = (server: Server) => {
    setEditing(server)
    setForm({
      name: server.name,
      public_endpoint: server.public_endpoint,
      interface_name: server.interface_name,
      listen_port: String(server.listen_port),
      network_cidr: server.network_cidr,
      dns_servers: (server.dns_servers || []).join(', '),
      default_allowed_ips: server.default_allowed_ips,
      mtu: String(server.mtu),
      persistent_keepalive: String(server.persistent_keepalive),
      managed_mode: server.managed_mode || 'local',
    })
    setShowAdd(false)
  }

  const openAdd = () => {
    setEditing(null)
    setForm(emptyForm)
    setShowAdd(true)
  }

  const openHostSetup = async (server: Server) => {
    setError('')
    try {
      const res = await fetch(`/api/servers/${server.id}/host-config`, { headers: auth })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setError(err.error || 'Failed to load host config')
        return
      }
      setHostSetup({ name: server.name, text: await res.text() })
      setHostCopied(false)
    } catch {
      setError('Failed to load host config')
    }
  }

  const copyHostConfig = async () => {
    if (!hostSetup) return
    try {
      await navigator.clipboard.writeText(hostSetup.text)
      setHostCopied(true)
    } catch {
      const el = document.createElement('textarea')
      el.value = hostSetup.text
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setHostCopied(true)
    }
  }

  if (isLoading) {
    return <div className="text-neutral-400">Loading...</div>
  }

  const modalOpen = showAdd || editing !== null || hostSetup !== null

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Servers</h1>
        <button
          onClick={openAdd}
          className="bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md"
        >
          Add Server
        </button>
      </div>

      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

      {modalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6 max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-white mb-1">{editing ? 'Edit Server' : 'Add Server'}</h2>
            <p className="text-sm text-neutral-400 mb-4">
              A server is one WireGuard interface on the VPN host (like wg0). Keys are generated
              automatically on creation.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                saveMutation.mutate()
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
              <div>
                <label htmlFor="sMode" className="block text-sm font-medium text-neutral-400 mb-2">
                  Managed by
                </label>
                <select
                  id="sMode"
                  value={form.managed_mode}
                  onChange={(e) => setForm((f) => ({ ...f, managed_mode: e.target.value }))}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                >
                  <option value="local">
                    This console (automatic — interface is created and synced on this host)
                  </option>
                  <option value="manual">Remote node (I will apply via Host Setup)</option>
                </select>
                {form.managed_mode === 'manual' && (
                  <p className="text-sm text-yellow-300 mt-2">
                    Kernel sync is skipped for this server. After creating it, use the Host Setup
                    button to get the node config.
                  </p>
                )}
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
                  disabled={saveMutation.isPending}
                  className="bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md disabled:opacity-50"
                >
                  {saveMutation.isPending ? 'Saving…' : editing ? 'Save Changes' : 'Create Server'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAdd(false)
                    setEditing(null)
                  }}
                  className="bg-neutral-700 hover:bg-neutral-600 text-white font-medium py-2 px-4 rounded-md"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {hostSetup && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-white mb-1">Host Setup — {hostSetup.name}</h2>
            <p className="text-sm text-neutral-400 mb-4">
              On the VPN server: save this as <code className="text-teal-400">wg0.conf</code>, then{' '}
              <code className="text-teal-400">sudo wg-quick up /tmp/wg0.conf</code> and run the NAT
              command from the comments. This re-creates the interface — do it once, and re-open
              this panel after adding peers to keep the peer list current.
            </p>
            <pre className="bg-neutral-950 border border-neutral-800 rounded-md p-4 text-xs text-neutral-300 overflow-x-auto whitespace-pre-wrap">
              {hostSetup.text}
            </pre>
            <div className="flex space-x-3 mt-4">
              <button
                onClick={copyHostConfig}
                className="bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md"
              >
                {hostCopied ? 'Copied ✓' : 'Copy Config'}
              </button>
              <button
                onClick={() => setHostSetup(null)}
                className="bg-neutral-700 hover:bg-neutral-600 text-white font-medium py-2 px-4 rounded-md"
              >
                Close
              </button>
            </div>
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
              <th className="px-6 py-3 text-right text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Actions
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
                  {server.managed_mode === 'manual' && (
                    <span className="ml-2 px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 text-blue-800">
                      manual
                    </span>
                  )}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                  <div className="flex justify-end gap-2">
                    <button onClick={() => openEdit(server)} className="text-teal-400 hover:text-teal-300">
                      Edit
                    </button>
                    <button
                      onClick={() => openHostSetup(server)}
                      className="text-blue-400 hover:text-blue-300"
                    >
                      Host Setup
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Delete server "${server.name}" and all of its peers?`))
                          removeMutation.mutate(server)
                      }}
                      className="text-red-400 hover:text-red-300"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
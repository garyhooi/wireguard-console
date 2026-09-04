import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { IconCopy, IconPlus, IconTerminal2 } from '@tabler/icons-react'
import {
  ActionLink,
  Badge,
  GhostButton,
  Modal,
  PageHeader,
  PrimaryButton,
  Skeleton,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
  inputCls,
  labelCls,
} from '../../lib/ui'

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
  node_id: string | null
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
  network_cidr: '10.8.0.0/24',
  dns_servers: '', // empty = backend default (tunnel gateway/AdGuard)
  default_allowed_ips: '0.0.0.0/0, ::/0',
  mtu: '1420',
  persistent_keepalive: '25',
  managed_mode: 'local',
  node_id: '',
}

// The WireGuard listen port is the port the host interface binds, taken
// from the public endpoint (host:port) — one port, not two.
function listenPortFromEndpoint(endpoint: string): string {
  const match = endpoint.trim().match(/:(\d+)$/)
  return match ? match[1] : '51820'
}

function ServersPage() {
  const queryClient = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState<Server | null>(null)
  const [error, setError] = useState('')
  const [form, setForm] = useState(emptyForm)
  const [hostSetup, setHostSetup] = useState<{ name: string; text: string } | null>(null)
  const [hostCopied, setHostCopied] = useState(false)

  const { data: nodes } = useQuery<{ id: string; name: string; status: string }[]>({
    queryKey: ['nodes'],
    queryFn: async () => {
      const res = await fetch('/api/nodes', { headers: auth })
      if (!res.ok) throw new Error('Failed to fetch nodes')
      return res.json()
    },
  })

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
        listen_port: Number(listenPortFromEndpoint(form.public_endpoint)),
        network_cidr: form.network_cidr,
        dns_servers: form.dns_servers.split(',').map((s) => s.trim()).filter(Boolean),
        default_allowed_ips: form.default_allowed_ips,
        mtu: Number(form.mtu),
        persistent_keepalive: Number(form.persistent_keepalive),
        managed_mode: form.managed_mode,
        node_id: form.managed_mode === 'remote' ? form.node_id : null,
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
      network_cidr: server.network_cidr,
      dns_servers: (server.dns_servers || []).join(', '),
      default_allowed_ips: server.default_allowed_ips,
      mtu: String(server.mtu),
      persistent_keepalive: String(server.persistent_keepalive),
      managed_mode: server.managed_mode || 'local',
      node_id: server.node_id || '',
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
    return (
      <div className="space-y-6">
        <div className="h-8 w-56 wgc-skeleton rounded-md" />
        <div className="h-64 w-full wgc-skeleton rounded-lg" />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Servers"
        description="A server is one WireGuard interface on the VPN host. Keys are generated automatically on creation."
        actions={<PrimaryButton onClick={openAdd}><IconPlus size={16} stroke={1.6} aria-hidden="true" />Add Server</PrimaryButton>}
      />

      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

      {/* Add / edit modal */}
      <Modal
        open={showAdd || editing !== null}
        onClose={() => {
          setShowAdd(false)
          setEditing(null)
        }}
        title={editing ? 'Edit Server' : 'Add Server'}
        description="A server is one WireGuard interface on the VPN host (like wg0). Keys are generated automatically on creation."
        className="max-w-lg"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            saveMutation.mutate()
          }}
          className="space-y-4"
        >
          <div>
            <label htmlFor="sName" className={labelCls}>
              Name
            </label>
            <input
              id="sName"
              required
              value={form.name}
              onChange={set('name')}
              placeholder="e.g. Production VPN"
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="sEndp" className={labelCls}>
              Public endpoint (host:port) — what peers connect to
            </label>
            <input
              id="sEndp"
              required
              value={form.public_endpoint}
              onChange={set('public_endpoint')}
              placeholder="e.g. 15.232.201.12:51820"
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="sMode" className={labelCls}>
              Managed by
            </label>
            <select
              id="sMode"
              value={form.managed_mode}
              onChange={(e) => setForm((f) => ({ ...f, managed_mode: e.target.value }))}
              className={inputCls}
            >
              <option value="local">
                This console (automatic — interface is created and synced on this host)
              </option>
              <option value="remote">Node (agent applies it automatically)</option>
              <option value="manual">Manual (Host Setup)</option>
            </select>
            {form.managed_mode === 'remote' && (
              <div className="mt-3">
                <label htmlFor="sNode" className={labelCls}>
                  Node
                </label>
                <select
                  id="sNode"
                  required
                  value={form.node_id}
                  onChange={(e) => setForm((f) => ({ ...f, node_id: e.target.value }))}
                  className={inputCls}
                >
                  <option value="" disabled>
                    {!nodes || nodes.length === 0 ? 'No nodes — create one under Nodes first' : 'Select a node…'}
                  </option>
                  {(nodes || []).map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {form.managed_mode === 'manual' && (
              <p className="text-sm text-amber-300 mt-2">
                Kernel sync is skipped for this server. After creating it, use the Host Setup
                button to get the node config.
              </p>
            )}
          </div>
          <div>
            <label htmlFor="sIface" className={labelCls}>
              Interface name
            </label>
            <input
              id="sIface"
              value={form.interface_name}
              onChange={set('interface_name')}
              className={inputCls}
            />
            <p className="text-xs text-zinc-500 mt-2">
              The WireGuard listen port follows the public endpoint above — e.g.{' '}
              <code className="text-zinc-400">vpn.example.com:51820</code> listens on{' '}
              <code className="text-zinc-400">51820</code>.
            </p>
          </div>
          <div>
            <label htmlFor="sCidr" className={labelCls}>
              Network (peer IPs are allocated from this)
            </label>
            <input
              id="sCidr"
              value={form.network_cidr}
              onChange={set('network_cidr')}
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="sDns" className={labelCls}>
              DNS servers (comma-separated)
            </label>
            <input
              id="sDns"
              value={form.dns_servers}
              onChange={set('dns_servers')}
              className={inputCls}
            />
            <p className="text-xs text-zinc-500 mt-2">
              Leave empty to use the tunnel gateway (e.g. 10.8.0.1) — required for domain
              filtering: AdGuard Home listens there and every peer DNS lookup passes the
              filter. If you enter a public DNS (e.g. 1.1.1.1, 8.8.8.8), peers bypass AdGuard
              and domain blocking won't apply to this server's peers.
            </p>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <GhostButton
              type="button"
              onClick={() => {
                setShowAdd(false)
                setEditing(null)
              }}
            >
              Cancel
            </GhostButton>
            <PrimaryButton type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? 'Saving…' : editing ? 'Save Changes' : 'Create Server'}
            </PrimaryButton>
          </div>
        </form>
      </Modal>

      {/* Host setup modal */}
      <Modal
        open={hostSetup !== null}
        onClose={() => setHostSetup(null)}
        title={hostSetup ? `Host Setup — ${hostSetup.name}` : undefined}
        description="On the VPN server: save this as wg0.conf, then run the NAT command from the comments. This re-creates the interface — do it once, and re-open this panel after adding peers to keep the peer list current."
        className="max-w-2xl"
        footer={
          <>
            <GhostButton onClick={() => setHostSetup(null)}>Close</GhostButton>
            <PrimaryButton onClick={copyHostConfig}>
              <IconCopy size={16} stroke={1.6} aria-hidden="true" />
              {hostCopied ? 'Copied' : 'Copy Config'}
            </PrimaryButton>
          </>
        }
      >
        <pre className="bg-zinc-950 border border-zinc-800 rounded-md p-4 text-xs text-zinc-300 overflow-x-auto whitespace-pre-wrap">
          {hostSetup?.text}
        </pre>
      </Modal>

      <div className={tableWrapCls}>
        <div className="overflow-x-auto">
          <table className={tableCls}>
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 bg-zinc-800/40">
                <th className={thCls}>Name</th>
                <th className={thCls}>Endpoint</th>
                <th className={thCls}>Interface</th>
                <th className={thCls}>Network</th>
                <th className={thCls}>Public Key</th>
                <th className={thCls}>Status</th>
                <th className={thCls + ' text-right'}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {servers?.map((server) => (
                <tr key={server.id} className="hover:bg-zinc-800/30 transition-colors">
                  <td className="px-5 py-3.5 whitespace-nowrap text-sm text-zinc-200">{server.name}</td>
                  <td className={tdCls + ' font-mono'}>{server.public_endpoint}</td>
                  <td className={tdCls + ' font-mono'}>{server.interface_name}</td>
                  <td className={tdCls + ' font-mono'}>{server.network_cidr}</td>
                  <td className={tdCls + ' font-mono'}>{server.server_public_key.substring(0, 16)}...</td>
                  <td className="px-5 py-3.5 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <Badge tone={server.status === 'active' ? 'good' : 'bad'}>{server.status}</Badge>
                      {server.managed_mode === 'manual' && <Badge tone="info">manual</Badge>}
                    </div>
                  </td>
                  <td className="px-5 py-3.5 whitespace-nowrap text-right text-sm">
                    <div className="flex justify-end gap-1">
                      <ActionLink onClick={() => openEdit(server)}>Edit</ActionLink>
                      <ActionLink
                        tone="default"
                        onClick={() => openHostSetup(server)}
                      >
                        <IconTerminal2 size={14} stroke={1.6} aria-hidden="true" />
                        Host Setup
                      </ActionLink>
                      <ActionLink
                        tone="danger"
                        onClick={() => {
                          if (confirm(`Delete server "${server.name}" and all of its peers?`))
                            removeMutation.mutate(server)
                        }}
                      >
                        Delete
                      </ActionLink>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

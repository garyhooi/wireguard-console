import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  EmptyState,
  GhostButton,
  PageHeader,
  Panel,
  PrimaryButton,
  Skeleton,
  StatusBadge,
  inputCls,
  labelCls,
} from '../../lib/ui'

interface Node {
  id: string
  name: string
  location: string
  status: string
  last_seen_at: string | null
  last_status: string
  server_count: number
}

export const Route = createFileRoute('/_authenticated/nodes')({
  component: NodesPage,
})

const auth = { Authorization: localStorage.getItem('token')! }

function NodesPage() {
  const queryClient = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ name: '', location: '' })
  const [join, setJoin] = useState<{ command: string; token: string } | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const { data: nodes, isLoading } = useQuery<Node[]>({
    queryKey: ['nodes'],
    queryFn: async () => {
      const res = await fetch('/api/nodes', { headers: auth })
      if (!res.ok) throw new Error('Failed to fetch nodes')
      return res.json()
    },
    refetchInterval: 15000,
  })

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/nodes', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) throw new Error('Failed to create node')
      return res.json()
    },
    onSuccess: (data: { join_command: string; token: string }) => {
      setForm({ name: '', location: '' })
      setJoin({ command: data.join_command, token: data.token })
      setError('')
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const removeMutation = useMutation({
    mutationFn: async (node: Node) => {
      const res = await fetch(`/api/nodes/${node.id}`, { method: 'DELETE', headers: auth })
      if (!res.ok) throw new Error('Failed to delete node')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['nodes'] }),
    onError: (e: Error) => setError(e.message),
  })

  const copyJoin = async () => {
    if (!join) return
    try {
      await navigator.clipboard.writeText(join.command)
      setCopied(true)
    } catch {
      const el = document.createElement('textarea')
      el.value = join.command
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setCopied(true)
    }
  }

  return (
    <div>
      <PageHeader
        title="Nodes"
        description="Each node is a machine running the wg-helper agent. One console manages every node: add a server with a node selected and the agent applies it there automatically."
        actions={<PrimaryButton onClick={() => setShowAdd(true)}>Add Node</PrimaryButton>}
      />

      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

      {showAdd && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 max-w-lg w-full mx-4">
            <h2 className="text-lg font-semibold text-zinc-100 mb-4">Add Node</h2>
            {!join ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  createMutation.mutate()
                }}
                className="space-y-4"
              >
                <div>
                  <label htmlFor="nName" className={labelCls}>
                    Name
                  </label>
                  <input
                    id="nName"
                    required
                    className={inputCls}
                    placeholder="e.g. Singapore Node"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </div>
                <div>
                  <label htmlFor="nLoc" className={labelCls}>
                    Location
                  </label>
                  <input
                    id="nLoc"
                    className={inputCls}
                    placeholder="e.g. SG, ap-southeast-1"
                    value={form.location}
                    onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                  />
                </div>
                <div className="flex gap-3">
                  <PrimaryButton disabled={createMutation.isPending}>
                    {createMutation.isPending ? 'Creating…' : 'Create Node'}
                  </PrimaryButton>
                  <GhostButton onClick={() => setShowAdd(false)}>Cancel</GhostButton>
                </div>
              </form>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-zinc-400">
                  Run this one-liner on the node machine. It installs Docker (if needed), builds the
                  agent and connects to this console. No inbound ports required.
                </p>
                <pre className="bg-zinc-950 border border-zinc-800 rounded-md p-4 text-xs text-zinc-300 overflow-x-auto whitespace-pre-wrap break-all">
                  {join.command}
                </pre>
                <div className="flex gap-3">
                  <PrimaryButton onClick={copyJoin}>{copied ? 'Copied ✓' : 'Copy Command'}</PrimaryButton>
                  <GhostButton
                    onClick={() => {
                      setJoin(null)
                      setShowAdd(false)
                    }}
                  >
                    Done
                  </GhostButton>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <Panel>
        {isLoading ? (
          <div className="p-5 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (nodes || []).length === 0 ? (
          <EmptyState
            title="No nodes yet"
            hint="The console host manages its own servers automatically. Add a node to manage machines in other regions."
            action={<PrimaryButton onClick={() => setShowAdd(true)}>Add Node</PrimaryButton>}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-zinc-800/80">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-600">
                  <th className="px-5 py-2.5 font-medium">Node</th>
                  <th className="px-5 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 font-medium">Servers</th>
                  <th className="px-5 py-2.5 font-medium">Last seen</th>
                  <th className="px-5 py-2.5 font-medium">Agent report</th>
                  <th className="px-5 py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {nodes?.map((node) => {
                  const online =
                    node.last_seen_at && Date.now() - new Date(node.last_seen_at).getTime() < 60_000
                  return (
                    <tr key={node.id} className="hover:bg-zinc-800/40 transition-colors">
                      <td className="px-5 py-3">
                        <p className="text-sm text-zinc-200">{node.name}</p>
                        {node.location && <p className="text-xs text-zinc-600">{node.location}</p>}
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={online ? 'ok' : node.last_seen_at ? 'warning' : 'error'} />
                      </td>
                      <td className="px-5 py-3 text-sm text-zinc-400 font-mono tabular-nums">
                        {node.server_count}
                      </td>
                      <td className="px-5 py-3 text-sm text-zinc-500 font-mono tabular-nums">
                        {node.last_seen_at ? new Date(node.last_seen_at).toLocaleString() : 'never'}
                      </td>
                      <td className="px-5 py-3 text-xs text-zinc-500 max-w-[220px] truncate" title={node.last_status}>
                        {node.last_status || '—'}
                      </td>
                      <td className="px-5 py-3 text-sm text-right">
                        <button
                          onClick={() => {
                            if (confirm(`Delete node "${node.name}"? Its servers fall back to manual mode.`))
                              removeMutation.mutate(node)
                          }}
                          className="text-red-400 hover:text-red-300 text-sm"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}
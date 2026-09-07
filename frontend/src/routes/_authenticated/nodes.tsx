import { createFileRoute } from '@tanstack/react-router'
import { Confirm2FA } from '../../lib/Confirm2FA'
import { apiFetch, apiJson } from '../../lib/api'
import { is2FAError, useStepUpMinutes } from '../../lib/stepup'
import { fmtDateTime } from '../../lib/timezone'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { IconCopy, IconPlus, IconTerminal2 } from '@tabler/icons-react'
import {
  ActionLink,
  Badge,
  EmptyState,
  GhostButton,
  Modal,
  PageHeader,
  PrimaryButton,
  Skeleton,
  StatusBadge,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
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
  agent_version?: string
  agent_mismatch?: boolean
}

export const Route = createFileRoute('/_authenticated/nodes')({
  component: NodesPage,
})


function NodesPage() {
  const queryClient = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ name: '', location: '' })
  const [join, setJoin] = useState<{
    command: string
    token: string
    rotated?: boolean
    nodeName?: string
  } | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  // Step-up 2FA gate: deleting a node and re-issuing its join command
  // (token rotation) are privileged — both require the admin's own code.
  const [pending2FA, setPending2FA] = useState<{
    label: string
    run: (code: string) => Promise<void>
  } | null>(null)

  // 2FA step-up grace: try the action without a code first — the server
  // accepts it when this session already verified within the window. Only
  // when the server answers with a 2FA error do we open the code modal.
  const stepUpMinutes = useStepUpMinutes()
  const gate2FA = (label: string, run: (code: string) => Promise<void>) => {
    if (stepUpMinutes <= 0) {
      setPending2FA({ label, run }) // grace off — ask immediately
      return
    }
    run('').catch((e: Error) => {
      if (is2FAError(e.message)) {
        setPending2FA({ label, run })
      } else {
        setError(e.message)
      }
    })
  }

  // Which admin is signed in — the Join-command (token rotate) action is
  // super_admin only, like the other sensitive re-issue actions.
  const { data: me } = useQuery<{ id: string; email: string; role: string }>({
    queryKey: ['me'],
    queryFn: async () => {
      return apiJson('/api/admins/me')
    },
  })
  const isSuperAdmin = me?.role === 'super_admin'

  const { data: nodes, isLoading } = useQuery<Node[]>({
    queryKey: ['nodes'],
    queryFn: async () => {
      return apiJson<Node[]>('/api/nodes')
    },
    refetchInterval: 15000,
  })

  const createMutation = useMutation({
    mutationFn: async () => {
      return apiJson<{ join_command: string; token: string }>('/api/nodes', { method: 'POST', body: form })
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
    mutationFn: async (args: { node: Node; code: string }) => {
      const res = await apiFetch(`/api/nodes/${args.node.id}`, {
        method: 'DELETE',
        body: { code: args.code },
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error((j as { error?: string }).error || 'Failed to delete node')
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['nodes'] }),
    onError: (e: Error) => setError(e.message),
  })

  const confirmDeleteNode = (node: Node) => {
    if (!confirm(`Delete node "${node.name}"? Its servers fall back to manual mode.`)) return
    gate2FA(`delete node "${node.name}"`, async (code) =>
      removeMutation.mutateAsync({ node, code }),
    )
  }

  // Re-issue the join command: the plaintext node token is only stored
  // hashed, so showing it again means rotating to a fresh one. The old
  // token stops working immediately — re-run the command on the node.
  //
  // This resets the token, so confirm FIRST: the warning must live in this
  // pre-2FA popup, because inside the 2FA step-up grace window the rotation
  // goes through with no code at all — a mis-click would strand the node.
  const rotateMutation = useMutation({
    mutationFn: async (args: { node: Node; code: string }) => {
      const res = await apiFetch(`/api/nodes/${args.node.id}/rotate-token`, {
        method: 'POST',
        body: { code: args.code },
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error((j as { error?: string }).error || 'Failed to rotate node token')
      }
      return (await res.json()) as { join_command: string; token: string }
    },
    onSuccess: (data: { join_command: string; token: string }, args: { node: Node; code: string }) => {
      setJoin({ command: data.join_command, token: data.token, rotated: true, nodeName: args.node.name })
      setCopied(false)
      setError('')
    },
    onError: (e: Error) => setError(e.message),
  })

  const confirmJoinCommand = (node: Node) => {
    if (
      !confirm(
        `Re-issue the join command for "${node.name}"?\n\n` +
          'This resets the node token — the previous one stops working ' +
          'immediately. Run the new command on the node to reconnect it.',
      )
    ) {
      return
    }
    gate2FA(`reset the join token for node "${node.name}"`, async (code) => {
      await rotateMutation.mutateAsync({ node, code })
    })
  }

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
        actions={<PrimaryButton onClick={() => setShowAdd(true)}><IconPlus size={16} stroke={1.6} aria-hidden="true" />Add Node</PrimaryButton>}
      />

      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

      <Modal
        open={showAdd || !!join}
        onClose={() => {
          setShowAdd(false)
          setJoin(null)
        }}
        title={join && !showAdd ? `Join command — ${join.nodeName || ''}` : 'Add Node'}
        className="max-w-lg"
      >
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
            <div className="flex justify-end gap-3 pt-2">
              <GhostButton onClick={() => setShowAdd(false)}>Cancel</GhostButton>
              <PrimaryButton type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Creating…' : 'Create Node'}
              </PrimaryButton>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            {join.rotated ? (
              <p className="text-sm text-amber-300">
                A new token was issued — the previous one stopped working. Run this on the node to
                reconnect it with the fresh token.
              </p>
            ) : (
              <p className="text-sm text-zinc-400">
                Run this one-liner on the node machine. It installs Docker (if needed), builds the
                agent and connects to this console. No inbound ports required.
              </p>
            )}
            <pre className="bg-zinc-950 border border-zinc-800 rounded-md p-4 text-xs text-zinc-300 overflow-x-auto whitespace-pre-wrap break-all">
              {join.command}
            </pre>
            <div className="flex justify-end gap-3">
              <GhostButton
                onClick={() => {
                  setJoin(null)
                  setShowAdd(false)
                }}
              >
                Done
              </GhostButton>
              <PrimaryButton onClick={copyJoin}>
                <IconCopy size={16} stroke={1.6} aria-hidden="true" />
                {copied ? 'Copied' : 'Copy Command'}
              </PrimaryButton>
            </div>
          </div>
        )}
      </Modal>

      <div className={tableWrapCls}>
        {isLoading ? (
          <div className="p-5 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (nodes || []).length === 0 ? (
          <EmptyState
            title="No nodes yet"
            hint="The console host manages its own servers automatically. Add a node to manage machines in other regions."
            action={<PrimaryButton onClick={() => setShowAdd(true)}><IconPlus size={16} stroke={1.6} aria-hidden="true" />Add Node</PrimaryButton>}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 bg-zinc-800/40">
                  <th className={thCls}>Node</th>
                  <th className={thCls}>Status</th>
                  <th className={thCls}>Agent Version</th>
                  <th className={thCls}>Servers</th>
                  <th className={thCls}>Last seen</th>
                  <th className={thCls} title="The agent's own status text from its most recent report (e.g. 'ok', or apply warnings)">
                    Last report
                  </th>
                  <th className={thCls + ' text-right'}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {nodes?.map((node) => {
                  const online =
                    node.last_seen_at && Date.now() - new Date(node.last_seen_at).getTime() < 60_000
                  return (
                    <tr key={node.id} className="hover:bg-zinc-800/30 transition-colors">
                      <td className="px-5 py-3">
                        <p className="text-sm text-zinc-200">{node.name}</p>
                        {node.location && <p className="text-xs text-zinc-600">{node.location}</p>}
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={online ? 'ok' : node.last_seen_at ? 'warning' : 'error'} />
                      </td>
                      <td className="px-5 py-3">
                        {node.agent_version && node.agent_version !== 'dev' ? (
                          <span className="inline-flex items-center gap-2">
                            <span className={`font-mono text-xs ${node.agent_mismatch ? 'text-red-400' : 'text-zinc-300'}`}>
                              {node.agent_version.startsWith('v') ? node.agent_version : `v${node.agent_version}`}
                            </span>
                            {node.agent_mismatch && (
                              <Badge tone="bad" label="update">
                                outdated
                              </Badge>
                            )}
                          </span>
                        ) : (
                          <span className="text-xs text-zinc-500 italic" title="The agent hasn't reported a version (unstamped build or not yet updated)">
                            unknown
                          </span>
                        )}
                      </td>
                      <td className={tdCls + ' font-mono tabular-nums'}>{node.server_count}</td>
                      <td className={tdCls + ' font-mono tabular-nums'}>
                        {node.last_seen_at ? fmtDateTime(node.last_seen_at) : 'never'}
                      </td>
                      <td className="px-5 py-3 text-xs text-zinc-500 max-w-[220px] truncate" title={node.last_status}>
                        {node.last_status || '—'}
                      </td>
                      <td className="px-5 py-3 text-right">
                        {isSuperAdmin && (
                          <ActionLink
                            onClick={() => {
                              setShowAdd(false)
                              setCopied(false)
                              confirmJoinCommand(node)
                            }}
                          >
                            <IconTerminal2 size={14} stroke={1.6} aria-hidden="true" />
                            Join command
                          </ActionLink>
                        )}
                        <ActionLink
                          tone="danger"
                          onClick={() => confirmDeleteNode(node)}
                        >
                          Delete
                        </ActionLink>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Step-up 2FA: delete node or re-issue its join command */}
      <Confirm2FA
        open={pending2FA !== null}
        onClose={() => setPending2FA(null)}
        title="Confirm with 2FA"
        description={
          pending2FA
            ? `Enter your own authenticator code to ${pending2FA.label}.`
            : undefined
        }
        onSubmit={pending2FA ? pending2FA.run : null}
        submitLabel="Authorize"
      />
    </div>
  )
}

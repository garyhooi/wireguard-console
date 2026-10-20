import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { IconPlus, IconTrash } from '@tabler/icons-react'
import { apiJson } from '../../lib/api'
import {
  Badge,
  GhostButton,
  Modal,
  PageHeader,
  Panel,
  PrimaryButton,
  Skeleton,
  tableCls,
  tdCls,
  thCls,
  inputCls,
  labelCls,
} from '../../lib/ui'

interface IPRule {
  id: string
  scope: 'global' | 'user'
  user_id: string | null
  user_email: string
  user_full_name: string
  cidr: string
  note: string
  created_at: string
}

interface LocalServerStatus {
  server_id: string
  name: string
  interface: string
  ok: boolean
  error: string
  applied_at?: string
}

interface IPConflict {
  rule_id: string
  cidr: string
  server: string
  reason: string
}

interface IPStatus {
  enabled: boolean
  rules_total: number
  global_rules: number
  user_rules: number
  expected_entries: number
  applied_servers: number
  failed_servers: number
  local_servers: LocalServerStatus[]
  unexpanded_user_rules: number
  conflicts: IPConflict[]
  last_sync_at?: string
  last_sync_error?: string
}

type BannerTone = 'red' | 'amber' | 'teal'

const BANNER_TONE_CLASS: Record<BannerTone, string> = {
  red: 'bg-red-500/10 border-red-500/30 text-red-300',
  amber: 'bg-amber-500/10 border-amber-500/30 text-amber-300',
  teal: 'bg-teal-500/10 border-teal-500/30 text-teal-300',
}

/**
 * One mutually-exclusive enforcement state — first matching state wins, so the
 * strip never stacks contradictory claims.
 */
function describeStatus(status: IPStatus): { tone: BannerTone; message: string } {
  if (status.last_sync_error) {
    return { tone: 'amber', message: `Last sync failed: ${status.last_sync_error}` }
  }
  if (status.enabled === false) {
    return {
      tone: 'red',
      message: 'IP blocking is disabled for this deployment (WG_IP_BLOCK=0).',
    }
  }
  const conflicts = status.conflicts ?? []
  if (conflicts.length > 0) {
    return {
      tone: 'amber',
      message: `${conflicts.length} conflict(s) not enforced — would break DNS/console.`,
    }
  }
  const unexpanded = status.unexpanded_user_rules ?? 0
  if (unexpanded > 0) {
    return { tone: 'amber', message: `${unexpanded} user rule(s) waiting for an active peer.` }
  }
  if (status.rules_total > 0 && status.applied_servers === 0) {
    return { tone: 'amber', message: 'Not applied yet — waiting for a server.' }
  }
  return {
    tone: 'teal',
    message: `Applied on ${status.applied_servers} server(s) — ${status.rules_total} rule(s) active.`,
  }
}

/** Address family from the stored CIDR — IPv6 always contains a colon. */
function ipFamily(cidr: string): 'IPv4' | 'IPv6' {
  return cidr.includes(':') ? 'IPv6' : 'IPv4'
}

const smallPrimaryButtonCls =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md bg-teal-700 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-teal-600 active:translate-y-[1px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500'

const iconButtonCls =
  'inline-flex items-center justify-center rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500'

export const Route = createFileRoute('/_authenticated/ip-rules')({
  component: IPBlockingPage,
})

export function IPBlockingPage() {
  const [showAddModal, setShowAddModal] = useState(false)
  const [scope, setScope] = useState<'global' | 'user'>('global')
  const [userId, setUserId] = useState('')
  const [cidr, setCidr] = useState('')
  const [note, setNote] = useState('')

  const {
    data: rulesData,
    isLoading,
    isError,
    refetch,
  } = useQuery<IPRule[]>({
    queryKey: ['ip-rules'],
    queryFn: async () => {
      return apiJson<IPRule[]>('/api/ip-rules')
    },
  })
  const rules = Array.isArray(rulesData) ? rulesData : []

  const { data: status, refetch: refetchStatus } = useQuery<IPStatus>({
    queryKey: ['ip-rules-status'],
    queryFn: async () => {
      return apiJson<IPStatus>('/api/ip-rules/status')
    },
    refetchInterval: 30000,
  })

  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: async () => {
      return apiJson<Array<{ id: string; email: string; full_name: string }>>('/api/users')
    },
    enabled: scope === 'user',
  })

  const addMutation = useMutation({
    mutationFn: async () => {
      const body: { scope: 'global' | 'user'; user_id?: string; cidr: string; note: string } = {
        scope,
        cidr: cidr.trim(),
        note: note.trim(),
      }
      if (scope === 'user') body.user_id = userId
      return apiJson<IPRule>('/api/ip-rules', { method: 'POST', body })
    },
    onSuccess: () => {
      setShowAddModal(false)
      setScope('global')
      setUserId('')
      setCidr('')
      setNote('')
      refetch()
      refetchStatus()
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiJson(`/api/ip-rules/${id}`, { method: 'DELETE' })
    },
    onSuccess: () => {
      refetch()
      refetchStatus()
    },
  })

  const openAddModal = () => {
    addMutation.reset()
    setScope('global')
    setUserId('')
    setCidr('')
    setNote('')
    setShowAddModal(true)
  }

  const closeAddModal = () => {
    addMutation.reset()
    setShowAddModal(false)
  }

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    if (!cidr.trim() || (scope === 'user' && !userId)) return
    addMutation.mutate()
  }

  const confirmDelete = (rule: IPRule) => {
    if (confirm(`Delete the rule for ${rule.cidr}?`)) {
      deleteMutation.mutate(rule.id)
    }
  }

  const banner = status ? describeStatus(status) : null
  const canSubmit = cidr.trim().length > 0 && (scope === 'global' || userId !== '')

  return (
    <div>
      <PageHeader
        title="IP Blocking"
        description="Drop traffic to IP addresses and CIDR ranges for VPN peers."
        actions={
          <button type="button" onClick={openAddModal} className={smallPrimaryButtonCls}>
            <IconPlus size={14} stroke={1.8} aria-hidden="true" />
            Add IP rule
          </button>
        }
      />

      {/* One mutually-exclusive enforcement state. */}
      {status && banner && (
        <div
          role="status"
          className={`mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3 text-sm ${BANNER_TONE_CLASS[banner.tone]}`}
        >
          <span className="font-medium">{banner.message}</span>
        </div>
      )}

      <Panel title="IP rules" className="mb-6">
        {isLoading ? (
          <div className="space-y-3 px-5 pb-5">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : isError ? (
          <p role="alert" className="px-5 pb-5 text-sm text-red-400">
            Failed to load IP rules.
          </p>
        ) : rules.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-zinc-500">
            No IP rules yet — add a destination IP or CIDR to block.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                  <th className={thCls}>Target</th>
                  <th className={thCls}>Scope</th>
                  <th className={thCls}>Note</th>
                  <th className={thCls + ' text-right'}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {rules.map((rule) => {
                  const family = ipFamily(rule.cidr)
                  return (
                    <tr key={rule.id} className="transition-colors hover:bg-zinc-800/30">
                      <td className={tdCls}>
                        <span className="inline-flex flex-wrap items-center gap-2">
                          <span className="font-mono">{rule.cidr}</span>
                          <Badge tone={family === 'IPv6' ? 'info' : 'neutral'}>{family}</Badge>
                        </span>
                      </td>
                      <td className={tdCls}>
                        {rule.scope === 'global' ? (
                          <Badge tone="accent">Global</Badge>
                        ) : (
                          rule.user_full_name || rule.user_email || '—'
                        )}
                      </td>
                      <td className={tdCls}>
                        <span className="text-zinc-500">{rule.note || '—'}</span>
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap text-right text-sm font-medium">
                        <button
                          type="button"
                          onClick={() => confirmDelete(rule)}
                          aria-label={`Delete ${rule.cidr}`}
                          title="Delete rule"
                          className={`${iconButtonCls} hover:bg-red-500/10 hover:text-red-300`}
                        >
                          <IconTrash size={14} stroke={1.6} aria-hidden="true" />
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

      <Modal
        open={showAddModal}
        onClose={closeAddModal}
        title="Add IP rule"
        className="max-w-md"
      >
        <form onSubmit={handleAdd} className="space-y-4">
          <div>
            <label htmlFor="ip-scope" className={labelCls}>
              Scope
            </label>
            <select
              id="ip-scope"
              className={inputCls}
              value={scope}
              onChange={(e) => {
                setScope(e.target.value as 'global' | 'user')
                setUserId('')
                addMutation.reset()
              }}
            >
              <option value="global">Global (all users)</option>
              <option value="user">User-specific</option>
            </select>
          </div>

          {scope === 'user' && (
            <div>
              <label htmlFor="ip-user" className={labelCls}>
                User
              </label>
              <select
                id="ip-user"
                className={inputCls}
                value={userId}
                onChange={(e) => {
                  setUserId(e.target.value)
                  addMutation.reset()
                }}
              >
                <option value="">Select a user</option>
                {users?.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.full_name || user.email}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label htmlFor="ip-cidr" className={labelCls}>
              IP address or CIDR
            </label>
            <input
              id="ip-cidr"
              type="text"
              required
              className={inputCls + ' font-mono'}
              placeholder="203.0.113.0/24 or 2001:db8::/48"
              value={cidr}
              onChange={(e) => {
                setCidr(e.target.value)
                addMutation.reset()
              }}
            />
            <p className="mt-1 text-xs text-zinc-500">
              Bare IPs are accepted (/32 or /128). IPv4 and IPv6 are supported.
            </p>
          </div>

          <div>
            <label htmlFor="ip-note" className={labelCls}>
              Note (optional)
            </label>
            <input
              id="ip-note"
              type="text"
              className={inputCls}
              placeholder="e.g. blocked CDN edge range"
              value={note}
              onChange={(e) => {
                setNote(e.target.value)
                addMutation.reset()
              }}
            />
          </div>

          {/* Server-side 400 (invalid/reserved CIDR) or 409 (duplicate). */}
          {addMutation.isError && (
            <p role="alert" className="text-sm text-red-400">
              {addMutation.error?.message || 'Failed to add IP rule.'}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <GhostButton type="button" onClick={closeAddModal}>
              Cancel
            </GhostButton>
            <PrimaryButton type="submit" disabled={addMutation.isPending || !canSubmit}>
              {addMutation.isPending ? 'Adding…' : 'Add rule'}
            </PrimaryButton>
          </div>
        </form>
      </Modal>

      {/* How it works — five short lines, same card as Domain Blocking. */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
        <h2 className="mb-3 text-sm font-medium text-zinc-200">How it works</h2>
        <ul className="space-y-1.5 text-sm leading-relaxed text-zinc-400">
          <li>• IPv4 and IPv6 addresses and CIDR ranges are both supported</li>
          <li>
            • <strong className="text-zinc-200">Global rules</strong> apply to every VPN user;{' '}
            <strong className="text-zinc-200">user rules</strong> apply only to that user&apos;s peers
          </li>
          <li>• Applies to all traffic from VPN peers — not just DNS</li>
          <li>• Destination addresses only — combine with Domain Blocking to block names</li>
          <li>• Changes apply immediately and self-heal after a reboot</li>
        </ul>
      </div>
    </div>
  )
}

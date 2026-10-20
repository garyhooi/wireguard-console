import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  IconChevronRight,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react'
import { apiJson } from '../../lib/api'
import { userLabel } from '../../lib/userLabel'
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
  /** Joined department name (newer backends); absorbs into the user label. */
  user_department_name?: string
  cidr: string
  note: string
  /** Set for group-targeted rules: cidr is "" and group_name is filled. */
  group_id?: string | null
  group_name?: string | null
  created_at: string
}

interface IPGroup {
  id: string
  name: string
  cidrs: string[]
  range_count: number
  rule_count: number
  created_at: string
}

interface DeleteGroupResult {
  status: string
  rules_removed: number
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

/**
 * Parse the group ranges textarea: one IP/CIDR per line (commas and whitespace
 * also work). Trims, drops empties, and de-dupes case-insensitively.
 */
function parseCIDRs(text: string): string[] {
  const seen = new Set<string>()
  const cidrs: string[] = []
  for (const raw of text.split(/[\s,]+/)) {
    const value = raw.trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    cidrs.push(value)
  }
  return cidrs
}

const smallButtonCls =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 active:translate-y-[1px] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500'

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
  const [target, setTarget] = useState<'cidr' | 'group'>('cidr')
  const [userId, setUserId] = useState('')
  const [cidr, setCidr] = useState('')
  const [groupId, setGroupId] = useState('')
  const [note, setNote] = useState('')

  // IP groups card + create/edit modal.
  const [showGroupModal, setShowGroupModal] = useState(false)
  const [editingGroup, setEditingGroup] = useState<IPGroup | null>(null)
  const [groupName, setGroupName] = useState('')
  const [groupCidrsText, setGroupCidrsText] = useState('')
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null)
  const [deleteGroupResult, setDeleteGroupResult] = useState<{
    name: string
    rulesRemoved: number
  } | null>(null)

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
      return apiJson<
        Array<{ id: string; email: string; full_name: string; department_name?: string }>
      >('/api/users')
    },
    enabled: scope === 'user',
  })

  const {
    data: groupsData,
    isLoading: groupsLoading,
    isError: groupsError,
    refetch: refetchGroups,
  } = useQuery<IPGroup[]>({
    queryKey: ['ip-groups'],
    queryFn: async () => {
      return apiJson<IPGroup[]>('/api/ip-groups')
    },
  })
  const groups = Array.isArray(groupsData) ? groupsData : []
  const groupById = new Map(groups.map((group) => [group.id, group]))

  const addMutation = useMutation({
    mutationFn: async (body: {
      scope: 'global' | 'user'
      user_id?: string
      cidr?: string
      group_id?: string
      note?: string
    }) => {
      return apiJson<IPRule>('/api/ip-rules', { method: 'POST', body })
    },
    onSuccess: () => {
      setShowAddModal(false)
      setScope('global')
      setTarget('cidr')
      setUserId('')
      setCidr('')
      setGroupId('')
      setNote('')
      refetch()
      refetchGroups()
      refetchStatus()
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiJson(`/api/ip-rules/${id}`, { method: 'DELETE' })
    },
    onSuccess: () => {
      refetch()
      refetchGroups()
      refetchStatus()
    },
  })

  // Create / edit a reusable group of IPs (cidrs replaces the whole list).
  const groupMutation = useMutation({
    mutationFn: async () => {
      const body = { name: groupName.trim(), cidrs: parseCIDRs(groupCidrsText) }
      return editingGroup
        ? apiJson<IPGroup>(`/api/ip-groups/${editingGroup.id}`, { method: 'PATCH', body })
        : apiJson<IPGroup>('/api/ip-groups', { method: 'POST', body })
    },
    onSuccess: () => {
      setShowGroupModal(false)
      setEditingGroup(null)
      refetchGroups()
      refetch()
    },
  })

  // Deleting a group cascades its rules server-side (rules_removed).
  const deleteGroupMutation = useMutation({
    mutationFn: async (group: IPGroup) => {
      return apiJson<DeleteGroupResult>(`/api/ip-groups/${group.id}`, {
        method: 'DELETE',
      })
    },
    onSuccess: (result, group) => {
      setDeleteGroupResult({
        name: group.name,
        rulesRemoved: result?.rules_removed ?? 0,
      })
      if (expandedGroupId === group.id) setExpandedGroupId(null)
      refetchGroups()
      refetch()
      refetchStatus()
    },
  })

  const openAddModal = () => {
    addMutation.reset()
    setScope('global')
    setTarget('cidr')
    setUserId('')
    setCidr('')
    setGroupId('')
    setNote('')
    setShowAddModal(true)
  }

  const closeAddModal = () => {
    addMutation.reset()
    setShowAddModal(false)
  }

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    // The API accepts exactly one of cidr / group_id.
    const body: {
      scope: 'global' | 'user'
      user_id?: string
      cidr?: string
      group_id?: string
      note?: string
    } = { scope }
    if (scope === 'user' && userId) {
      body.user_id = userId
    }
    if (target === 'group') {
      if (!groupId) return
      body.group_id = groupId
    } else {
      body.cidr = cidr.trim()
      body.note = note.trim()
    }
    addMutation.mutate(body)
  }

  const confirmDelete = (rule: IPRule) => {
    const label = rule.group_id ? `the group "${rule.group_name || 'group'}"` : rule.cidr
    if (confirm(`Delete the rule for ${label}?`)) {
      deleteMutation.mutate(rule.id)
    }
  }

  const openNewGroupModal = () => {
    groupMutation.reset()
    setEditingGroup(null)
    setGroupName('')
    setGroupCidrsText('')
    setDeleteGroupResult(null)
    setShowGroupModal(true)
  }

  const openEditGroupModal = (group: IPGroup) => {
    groupMutation.reset()
    setEditingGroup(group)
    setGroupName(group.name)
    setGroupCidrsText(group.cidrs.join('\n'))
    setDeleteGroupResult(null)
    setShowGroupModal(true)
  }

  const closeGroupModal = () => {
    groupMutation.reset()
    setShowGroupModal(false)
    setEditingGroup(null)
  }

  const handleSaveGroup = (e: React.FormEvent) => {
    e.preventDefault()
    if (!groupName.trim() || groupCidrs.length === 0) return
    groupMutation.mutate()
  }

  const confirmDeleteGroup = (group: IPGroup) => {
    const cascade =
      group.rule_count > 0 ? ` ${group.rule_count} rule(s) using it will be removed too.` : ''
    if (confirm(`Delete group "${group.name}"?${cascade}`)) {
      deleteGroupMutation.mutate(group)
    }
  }

  const banner = status ? describeStatus(status) : null
  const groupCidrs = parseCIDRs(groupCidrsText)
  const canSubmit =
    (target === 'group' ? groupId !== '' : cidr.trim().length > 0) &&
    (scope === 'global' || userId !== '')

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

      {/* Reusable groups: one rule can block every IP in a group. */}
      <Panel
        title="IP groups"
        className="mb-6"
        right={
          <button type="button" onClick={openNewGroupModal} className={smallButtonCls}>
            <IconPlus size={13} stroke={1.6} aria-hidden="true" />
            New group
          </button>
        }
      >
        {deleteGroupResult && (
          <p role="status" className="px-5 pb-2 text-xs text-zinc-500">
            Deleted "{deleteGroupResult.name}" — {deleteGroupResult.rulesRemoved} rule
            {deleteGroupResult.rulesRemoved === 1 ? '' : 's'} removed.
          </p>
        )}
        {groupsLoading ? (
          <div className="px-5 pb-4">
            <Skeleton className="h-8 w-full" />
          </div>
        ) : groupsError ? (
          <p role="alert" className="px-5 pb-4 text-sm text-red-400">
            Failed to load IP groups.
          </p>
        ) : groups.length === 0 ? (
          <p className="px-5 pb-4 text-sm text-zinc-500">
            No IP groups yet — create one to block many IPs at once.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-800/60 border-t border-zinc-800/60">
            {groups.map((group) => {
              const expanded = expandedGroupId === group.id
              return (
                <li key={group.id}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-2.5">
                    <button
                      type="button"
                      onClick={() => setExpandedGroupId(expanded ? null : group.id)}
                      aria-expanded={expanded}
                      className="group flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                    >
                      <IconChevronRight
                        size={13}
                        stroke={1.8}
                        aria-hidden="true"
                        className={`shrink-0 text-zinc-500 transition-transform ${expanded ? 'rotate-90' : ''}`}
                      />
                      <span className="truncate text-sm font-medium text-zinc-200 group-hover:text-zinc-100">
                        {group.name}
                      </span>
                    </button>
                    <span className="text-xs text-zinc-500 tabular-nums">
                      {group.range_count} range{group.range_count === 1 ? '' : 's'}
                    </span>
                    <span className="text-xs text-zinc-500 tabular-nums">
                      used by {group.rule_count} rule{group.rule_count === 1 ? '' : 's'}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openEditGroupModal(group)}
                        aria-label={`Edit ${group.name}`}
                        title="Edit group"
                        className={iconButtonCls}
                      >
                        <IconPencil size={14} stroke={1.6} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => confirmDeleteGroup(group)}
                        aria-label={`Delete ${group.name}`}
                        title="Delete group"
                        className={`${iconButtonCls} hover:bg-red-500/10 hover:text-red-300`}
                      >
                        <IconTrash size={14} stroke={1.6} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  {expanded && (
                    <div className="flex flex-wrap gap-1.5 px-5 pb-3 pl-10">
                      {group.cidrs.length === 0 ? (
                        <span className="text-xs text-zinc-500">No ranges.</span>
                      ) : (
                        group.cidrs.map((groupCidr) => (
                          <code
                            key={groupCidr}
                            className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-400"
                          >
                            {groupCidr}
                          </code>
                        ))
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Panel>

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
                  const group = rule.group_id ? groupById.get(rule.group_id) : undefined
                  return (
                    <tr key={rule.id} className="transition-colors hover:bg-zinc-800/30">
                      <td className={tdCls}>
                        {rule.group_id ? (
                          <span className="inline-flex flex-wrap items-center gap-1.5">
                            <span className="text-xs text-zinc-500">Group:</span>
                            <Badge tone="accent">
                              {rule.group_name || group?.name || 'group'}
                            </Badge>
                            {group && (
                              <span className="text-xs text-zinc-500">
                                · {group.range_count} range{group.range_count === 1 ? '' : 's'}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="inline-flex flex-wrap items-center gap-2">
                            <span className="font-mono">{rule.cidr}</span>
                            <Badge tone={family === 'IPv6' ? 'info' : 'neutral'}>{family}</Badge>
                          </span>
                        )}
                      </td>
                      <td className={tdCls}>
                        {rule.scope === 'global' ? (
                          <Badge tone="accent">Global</Badge>
                        ) : (
                          userLabel(
                            rule.user_full_name,
                            rule.user_email,
                            rule.user_department_name,
                          )
                        )}
                      </td>
                      <td className={tdCls}>
                        <span className="text-zinc-500">{rule.note || '—'}</span>
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap text-right text-sm font-medium">
                        <button
                          type="button"
                          onClick={() => confirmDelete(rule)}
                          aria-label={`Delete ${
                            rule.group_id
                              ? `${rule.group_name || 'group'} rule`
                              : rule.cidr
                          }`}
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
                    {userLabel(user.full_name, user.email, user.department_name)}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label htmlFor="ip-target" className={labelCls}>
              Target
            </label>
            <select
              id="ip-target"
              className={inputCls}
              value={target}
              onChange={(e) => {
                setTarget(e.target.value as 'cidr' | 'group')
                setGroupId('')
                addMutation.reset()
              }}
            >
              <option value="cidr">IP address</option>
              <option value="group">IP group</option>
            </select>
          </div>

          {target === 'cidr' ? (
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
          ) : (
            <div>
              <label htmlFor="ip-group" className={labelCls}>
                IP group
              </label>
              <select
                id="ip-group"
                className={inputCls}
                value={groupId}
                onChange={(e) => {
                  setGroupId(e.target.value)
                  addMutation.reset()
                }}
              >
                <option value="">Select a group</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name} ({group.range_count} range
                    {group.range_count === 1 ? '' : 's'})
                  </option>
                ))}
              </select>
              {!groupsLoading && groups.length === 0 && (
                <p className="mt-1 text-xs text-zinc-500">
                  No groups yet — create one to block many IPs at once.
                </p>
              )}
            </div>
          )}

          {target === 'cidr' && (
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
          )}

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

      {/* Create / edit a reusable group of IPs/CIDRs. */}
      <Modal
        open={showGroupModal}
        onClose={closeGroupModal}
        title={editingGroup ? 'Edit IP group' : 'New IP group'}
        className="max-w-md"
      >
        <form onSubmit={handleSaveGroup} className="space-y-4">
          <div>
            <label htmlFor="group-name" className={labelCls}>
              Name
            </label>
            <input
              id="group-name"
              type="text"
              required
              className={inputCls}
              placeholder="Blocked CDNs"
              value={groupName}
              onChange={(e) => {
                setGroupName(e.target.value)
                groupMutation.reset()
              }}
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <label htmlFor="group-cidrs" className={labelCls + ' mb-0'}>
                IP addresses / CIDRs
              </label>
              <span className="text-xs text-zinc-500 tabular-nums">
                {groupCidrs.length} range{groupCidrs.length === 1 ? '' : 's'}
              </span>
            </div>
            <textarea
              id="group-cidrs"
              rows={6}
              className={inputCls + ' font-mono text-xs'}
              placeholder={'203.0.113.0/24\n2001:db8::/48'}
              value={groupCidrsText}
              onChange={(e) => {
                setGroupCidrsText(e.target.value)
                groupMutation.reset()
              }}
            />
            <p className="mt-1 text-xs text-zinc-500">
              One IP or CIDR per line (commas also work). e.g.{' '}
              <code className="rounded bg-zinc-800 px-1">203.0.113.0/24</code>,{' '}
              <code className="rounded bg-zinc-800 px-1">2001:db8::/48</code>
            </p>
          </div>

          {/* Server-side 400 (invalid name/range) or 409 (duplicate name). */}
          {groupMutation.isError && (
            <p role="alert" className="text-sm text-red-400">
              {groupMutation.error?.message || 'Failed to save IP group.'}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <GhostButton type="button" onClick={closeGroupModal}>
              Cancel
            </GhostButton>
            <PrimaryButton
              type="submit"
              disabled={groupMutation.isPending || !groupName.trim() || groupCidrs.length === 0}
            >
              {groupMutation.isPending
                ? 'Saving…'
                : editingGroup
                  ? 'Save group'
                  : 'Create group'}
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

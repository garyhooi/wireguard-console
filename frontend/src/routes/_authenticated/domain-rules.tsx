import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { IconPlus, IconRefresh } from '@tabler/icons-react'
import { apiJson } from '../../lib/api'
import { fmtDate } from '../../lib/timezone'
import {
  Badge,
  EmptyState,
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

interface DomainRule {
  id: string
  scope: 'global' | 'user'
  user_id: string | null
  user_email?: string
  user_full_name?: string
  domain: string
  created_by: string | null
  created_at: string
}

interface SyncStatus {
  reachable: boolean
  error?: string
  protection_on: boolean
  blocking_mode: string
  blocking_ipv4: string
  expected_rules: number
  missing_rules: number
  block_page_ip: string
  /** AdGuard's live "Pause protection" state (not the filtering setting). */
  protection_enabled?: boolean
  /** AdGuard's filtering-settings switch. */
  filtering_enabled?: boolean
  /** Remaining protection pause, in milliseconds. */
  protection_disabled_duration?: number
  /** Stored rules AdGuard would ignore (invalid after normalization). */
  invalid_rules?: number
  /** Rules AdGuard actually has for this console. */
  actual_rules?: number
  last_sync_at?: string
  last_sync_error?: string
}

type BannerTone = 'red' | 'amber' | 'teal'

interface SyncBanner {
  tone: BannerTone
  message: string
}

const BANNER_TONE_CLASS: Record<BannerTone, string> = {
  red: 'bg-red-500/10 border-red-500/30 text-red-300',
  amber: 'bg-amber-500/10 border-amber-500/30 text-amber-300',
  teal: 'bg-teal-500/10 border-teal-500/30 text-teal-300',
}

/**
 * One mutually-exclusive status message for AdGuard — first matching state
 * wins, so the strip never stacks contradictory claims (e.g. "reachable" while
 * protection is paused).
 */
function describeSyncStatus(status: SyncStatus): SyncBanner {
  if (!status.reachable) {
    return { tone: 'red', message: 'AdGuard unreachable — rules are not enforced.' }
  }
  // protection_enabled is the live pause state. Fall back to the legacy
  // protection_on flag when talking to an API that predates it.
  const protectionPaused =
    status.protection_enabled === false ||
    (status.protection_enabled === undefined && status.protection_on === false)
  if (protectionPaused) {
    const minutes =
      status.protection_disabled_duration && status.protection_disabled_duration > 0
        ? Math.max(1, Math.ceil(status.protection_disabled_duration / 60_000))
        : 0
    return {
      tone: 'red',
      message:
        minutes > 0
          ? `AdGuard protection is paused — blocking is disabled for another ~${minutes} min.`
          : 'AdGuard protection is paused — blocking is disabled.',
    }
  }
  if (status.filtering_enabled === false) {
    return { tone: 'amber', message: 'AdGuard filtering is disabled — rules are not enforced.' }
  }
  const invalidRules = status.invalid_rules ?? 0
  if (invalidRules > 0) {
    return {
      tone: 'amber',
      message: `${invalidRules} stored rule(s) are not valid and are not enforced.`,
    }
  }
  if (status.missing_rules > 0) {
    return {
      tone: 'amber',
      message: `${status.missing_rules} rule(s) missing in AdGuard — re-syncing shortly.`,
    }
  }
  if (status.last_sync_error) {
    return { tone: 'amber', message: `Last AdGuard sync failed: ${status.last_sync_error}` }
  }
  const synced = status.actual_rules ?? status.expected_rules
  return { tone: 'teal', message: `AdGuard reachable — ${synced} rule(s) synced.` }
}

interface DomainCheckRule {
  text: string
  filter_list_id?: number
}

interface DomainCheck {
  domain: string
  blocked: boolean
  reachable: boolean
  protection_enabled?: boolean
  filtering_enabled?: boolean
  reason?: string
  rule?: string
  rules?: DomainCheckRule[]
  error?: string
}

/** Rule text(s) that matched the tested domain. */
function matchedRuleTexts(result: DomainCheck): string[] {
  const texts = (result.rules ?? []).map((rule) => rule.text).filter(Boolean)
  if (texts.length === 0 && result.rule) texts.push(result.rule)
  return texts
}

/** Enforcement problems that make a "blocked/allowed" answer misleading. */
function enforcementProblems(result: DomainCheck): string[] {
  const problems: string[] = []
  if (result.protection_enabled === false) problems.push('protection is paused')
  if (result.filtering_enabled === false) problems.push('filtering is disabled')
  return problems
}

const smallButtonCls =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 active:translate-y-[1px] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500'

export const Route = createFileRoute('/_authenticated/domain-rules')({
  component: DomainRulesPage,
})

export function DomainRulesPage() {
  const [showAddModal, setShowAddModal] = useState(false)
  const [scope, setScope] = useState<'global' | 'user'>('global')
  const [domain, setDomain] = useState('')
  const [userId, setUserId] = useState('')
  const [testDomain, setTestDomain] = useState('')

  const { data: rules, isLoading, refetch } = useQuery<DomainRule[]>({
    queryKey: ['domain-rules'],
    queryFn: async () => {
      return apiJson<DomainRule[]>('/api/domain-rules')
    },
  })

  const {
    data: status,
    refetch: refetchStatus,
  } = useQuery<SyncStatus>({
    queryKey: ['domain-rules-status'],
    queryFn: async () => {
      return apiJson<SyncStatus>('/api/domain-rules/status')
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
    mutationFn: async (data: { scope: string; user_id?: string; domain: string }) => {
      return apiJson('/api/domain-rules', { method: 'POST', body: data })
    },
    onSuccess: () => {
      setShowAddModal(false)
      setDomain('')
      setUserId('')
      refetch()
      refetchStatus()
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiJson(`/api/domain-rules/${id}`, { method: 'DELETE' })
    },
    onSuccess: () => {
      refetch()
      refetchStatus()
    },
  })

  // Force a full push to AdGuard, then re-read the status it reports.
  const syncMutation = useMutation({
    mutationFn: async () => {
      return apiJson<{ status: string }>('/api/domain-rules/sync', { method: 'POST' })
    },
    onSuccess: () => {
      refetchStatus()
      refetch()
    },
  })

  // "Would AdGuard block this domain?" — GET /api/domain-rules/check.
  const checkMutation = useMutation({
    mutationFn: async (value: string) => {
      return apiJson<DomainCheck>(`/api/domain-rules/check?domain=${encodeURIComponent(value)}`)
    },
  })

  const openAddModal = () => {
    addMutation.reset()
    setShowAddModal(true)
  }

  const closeAddModal = () => {
    addMutation.reset()
    setShowAddModal(false)
  }

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    const data: { scope: string; user_id?: string; domain: string } = {
      scope,
      domain,
    }
    if (scope === 'user' && userId) {
      data.user_id = userId
    }
    addMutation.mutate(data)
  }

  const handleTestDomain = (e: React.FormEvent) => {
    e.preventDefault()
    const value = testDomain.trim()
    if (!value) return
    checkMutation.mutate(value)
  }

  const active = Array.isArray(rules) ? rules : []
  const banner = status ? describeSyncStatus(status) : null
  const checkResult = checkMutation.data
  const checkRuleTexts = checkResult ? matchedRuleTexts(checkResult) : []
  const checkProblems = checkResult ? enforcementProblems(checkResult) : []

  return (
    <div>
      <PageHeader
        title="Domain Blocking"
        description="AdGuard Home rules that block domains for all users or specific users. Changes sync to AdGuard immediately."
        actions={
          <PrimaryButton onClick={openAddModal}>
            <IconPlus size={16} stroke={1.6} aria-hidden="true" />
            Add Rule
          </PrimaryButton>
        }
      />

      {/* AdGuard sync / health status — one mutually-exclusive state. */}
      {status && banner && (
        <div className="mb-5 flex flex-wrap items-start gap-2">
          <div
            role="status"
            className={`flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3 text-sm ${BANNER_TONE_CLASS[banner.tone]}`}
          >
            <span className="font-medium">{banner.message}</span>
            {status.reachable && (
              <span className="opacity-80">
                block mode: <code className="font-mono">{status.blocking_mode}</code>
                {status.blocking_ipv4 ? ` → ${status.blocking_ipv4}` : ''}
              </span>
            )}
            {status.error && (
              <span className="opacity-80 font-mono text-xs break-all">{status.error}</span>
            )}
          </div>
          {status.reachable && (
            <button
              type="button"
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className={smallButtonCls}
            >
              <IconRefresh
                size={13}
                stroke={1.6}
                className={syncMutation.isPending ? 'animate-spin' : ''}
                aria-hidden="true"
              />
              {syncMutation.isPending ? 'Resyncing…' : 'Resync now'}
            </button>
          )}
        </div>
      )}
      {syncMutation.isError && (
        <p role="alert" className="mb-5 text-sm text-red-400">
          {syncMutation.error?.message || 'AdGuard sync failed.'}
        </p>
      )}

      {/* Would AdGuard actually block this domain? */}
      <form
        onSubmit={handleTestDomain}
        className="mb-6 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <label
            htmlFor="test-domain"
            className="text-xs font-medium uppercase tracking-wider text-zinc-500"
          >
            Test domain
          </label>
          <div className="w-60 max-w-full">
            <input
              id="test-domain"
              type="text"
              className={`${inputCls} font-mono`}
              placeholder="example.com"
              value={testDomain}
              onChange={(e) => {
                setTestDomain(e.target.value)
                checkMutation.reset()
              }}
            />
          </div>
          <button
            type="submit"
            disabled={checkMutation.isPending || !testDomain.trim()}
            className={smallButtonCls}
          >
            {checkMutation.isPending ? 'Testing…' : 'Test'}
          </button>
          {checkMutation.isError && (
            <span role="alert" className="text-xs text-red-400">
              {checkMutation.error?.message || 'Domain check failed.'}
            </span>
          )}
        </div>
        {checkResult && (
          <div
            aria-live="polite"
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-800/60 pt-2 text-xs"
          >
            {checkResult.error ? (
              <span className="text-red-400">{checkResult.error}</span>
            ) : checkResult.reachable === false ? (
              <span className="font-medium text-red-300">
                AdGuard unreachable — blocking could not be verified.
              </span>
            ) : (
              <>
                <span
                  className={`font-medium ${checkResult.blocked ? 'text-red-300' : 'text-teal-300'}`}
                >
                  {checkResult.blocked
                    ? `Blocked${checkResult.reason ? ` (${checkResult.reason})` : ''}`
                    : 'Allowed by AdGuard'}
                </span>
                {checkResult.blocked && checkRuleTexts.length > 0 && (
                  <span className="font-mono text-zinc-400 break-all">
                    {checkRuleTexts.join(' · ')}
                  </span>
                )}
                {checkProblems.length > 0 && (
                  <span className="text-amber-300">
                    {checkProblems.join('; ')} — blocking is not enforced.
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </form>

      <Modal
        open={showAddModal}
        onClose={closeAddModal}
        title="Add Domain Rule"
        className="max-w-md"
      >
        <form onSubmit={handleAdd} className="space-y-4">
          <div>
            <label htmlFor="scope" className={labelCls}>
              Scope
            </label>
            <select
              id="scope"
              className={inputCls}
              value={scope}
              onChange={(e) => setScope(e.target.value as 'global' | 'user')}
            >
              <option value="global">Global (all users)</option>
              <option value="user">User-specific</option>
            </select>
          </div>

          {scope === 'user' && (
            <div>
              <label htmlFor="userId" className={labelCls}>
                User
              </label>
              <select
                id="userId"
                className={inputCls}
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
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
            <label htmlFor="domain" className={labelCls}>
              Domain
            </label>
            <input
              id="domain"
              type="text"
              required
              className={inputCls + ' font-mono'}
              placeholder="example.com"
              value={domain}
              onChange={(e) => {
                setDomain(e.target.value)
                // Clear a previous server rejection as soon as the input changes.
                addMutation.reset()
              }}
            />
            <p className="text-zinc-500 text-xs mt-1">
              Enter domain without protocol (e.g., <code className="bg-zinc-800 px-1 rounded">example.com</code>)
            </p>
          </div>

          {/* Server-side validation / duplicate rejection from POST /api/domain-rules. */}
          {addMutation.isError && (
            <p role="alert" className="text-red-400 text-sm">
              {addMutation.error?.message || 'Failed to add rule.'}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <GhostButton type="button" onClick={closeAddModal}>
              Cancel
            </GhostButton>
            <PrimaryButton type="submit" disabled={addMutation.isPending || !domain}>
              {addMutation.isPending ? 'Adding…' : 'Add Rule'}
            </PrimaryButton>
          </div>
        </form>
      </Modal>

      <div className="border border-zinc-800 rounded-lg bg-zinc-900/50 p-6 mb-6">
        <h2 className="text-sm font-medium text-zinc-200 mb-3">How It Works</h2>
        <ul className="text-zinc-400 text-sm space-y-1.5 leading-relaxed">
          <li>• <strong className="text-zinc-200">Global rules</strong> block domains for all users</li>
          <li>• <strong className="text-zinc-200">User rules</strong> block domains for specific users only</li>
          <li>• Rules use adblock-style syntax: <code className="bg-zinc-800 px-1 rounded">||example.com^</code></li>
          <li>• Subdomains are blocked automatically (e.g., <code className="bg-zinc-800 px-1 rounded">||example.com^</code> blocks example.com and *.example.com)</li>
          <li>• Changes are synced to AdGuard Home immediately</li>
        </ul>
      </div>

      <div className={tableWrapCls}>
        {isLoading ? (
          <div className="p-5 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : active.length === 0 ? (
          <EmptyState
            title="No domain rules yet"
            hint="Add a rule to block domains via AdGuard Home for all users or a specific user."
            action={<PrimaryButton onClick={openAddModal}><IconPlus size={16} stroke={1.6} aria-hidden="true" />Add Rule</PrimaryButton>}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 bg-zinc-800/40">
                  <th className={thCls}>Domain</th>
                  <th className={thCls}>Scope</th>
                  <th className={thCls}>User</th>
                  <th className={thCls}>Created</th>
                  <th className={thCls + ' text-right'}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {active.map((rule) => (
                  <tr key={rule.id} className="hover:bg-zinc-800/30 transition-colors">
                    <td className={tdCls + ' font-mono'}>{`||${rule.domain}^`}</td>
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      <Badge tone={rule.scope === 'global' ? 'accent' : 'info'}>{rule.scope}</Badge>
                    </td>
                    <td className={tdCls}>
                      {rule.user_full_name || rule.user_email || '—'}
                    </td>
                    <td className={tdCls}>
                      {fmtDate(rule.created_at)}
                    </td>
                    <td className="px-5 py-3.5 whitespace-nowrap text-right text-sm font-medium">
                      <button
                        onClick={() => deleteMutation.mutate(rule.id)}
                        className="inline-flex items-center text-sm rounded-md px-2 py-1 text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

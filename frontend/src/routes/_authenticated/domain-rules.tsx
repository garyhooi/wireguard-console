import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  IconChevronRight,
  IconDownload,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react'
import { apiJson } from '../../lib/api'
import { fmtDate } from '../../lib/timezone'
import {
  Badge,
  EmptyState,
  GhostButton,
  Modal,
  PageHeader,
  Panel,
  PrimaryButton,
  Skeleton,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
  inputCls,
  labelCls,
  tabGroupCls,
  toolbarTab,
} from '../../lib/ui'

interface DomainRule {
  id: string
  scope: 'global' | 'user'
  user_id: string | null
  user_email?: string
  user_full_name?: string
  domain: string
  /** Set for group-targeted rules: domain is "" and group_name is filled. */
  group_id?: string | null
  group_name?: string | null
  created_by: string | null
  created_at: string
}

interface DomainGroup {
  id: string
  name: string
  domains: string[]
  domain_count: number
  rule_count: number
  created_at: string
}

interface DeleteGroupResult {
  status: string
  rules_removed: number
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

/**
 * Parse the group domains textarea: one domain per line (commas and whitespace
 * also work). Trims, drops empties, and de-dupes case-insensitively.
 */
function parseDomains(text: string): string[] {
  const seen = new Set<string>()
  const domains: string[] = []
  for (const raw of text.split(/[\s,]+/)) {
    const value = raw.trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    domains.push(value)
  }
  return domains
}

const smallButtonCls =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 active:translate-y-[1px] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500'

const iconButtonCls =
  'inline-flex items-center justify-center rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500'

const certDownloadCls =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-teal-600/60 bg-teal-700/25 px-3 py-1.5 text-xs font-medium text-teal-200 transition-colors hover:border-teal-500 hover:bg-teal-700/40 hover:text-teal-100 active:translate-y-[1px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500'

type CertPlatform = 'ios' | 'android' | 'macos' | 'windows'

/** Per-platform, one-time steps to trust the block page's internal root CA.
 *  macOS and Windows also get a terminal command: the macOS GUI importer can
 *  fail with "unable to import … error -25294" when Keychain Access targets the
 *  iCloud "Local Items" keychain, and importing into System alone leaves the
 *  certificate explicitly untrusted — security(1)/certutil do both in one step. */
const CERT_PLATFORMS: Array<{
  id: CertPlatform
  label: string
  steps: string[]
  command?: string
  note?: string
}> = [
  {
    id: 'ios',
    label: 'iOS/iPadOS',
    steps: [
      'Download the certificate on the device.',
      'Settings → Profile Downloaded → Install.',
      'Settings → General → About → Certificate Trust Settings → enable full trust for the certificate.',
    ],
  },
  {
    id: 'android',
    label: 'Android',
    steps: [
      'Download the certificate on the device.',
      'Settings → Security → Encryption & credentials (or "More security settings").',
      'Install a certificate → CA certificate → choose the downloaded file.',
    ],
  },
  {
    id: 'macos',
    label: 'macOS',
    steps: [
      'Download the certificate.',
      'Open Terminal and run the command below — it imports the certificate into the System keychain AND marks it trusted in one step (no Keychain Access, no "untrusted" state).',
      'Quit and reopen Chrome, then reload the blocked site. Verify the import with: security find-certificate -c "Caddy Local Authority" /Library/Keychains/System.keychain',
    ],
    command:
      'sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/Downloads/wgconsole-block-page-ca.crt',
    note: 'Do not import into the iCloud keychain through Keychain Access — it can hang or fail with "unable to import … error -25294" (a macOS Keychain bug, not a bad certificate). If you use the GUI instead: import into the System keychain, then double-click "Caddy Local Authority", expand Trust, and set "When using this certificate: Always Trust" — an imported but untrusted certificate will not fix Chrome.',
  },
  {
    id: 'windows',
    label: 'Windows',
    steps: [
      'Download the certificate.',
      'Open Command Prompt as Administrator and run the command below (it adds it to Trusted Root Certification Authorities).',
      'Restart Chrome, then reload the blocked site. Or use the GUI: right-click the file → Install Certificate → Local Machine → Trusted Root Certification Authorities.',
    ],
    command:
      'certutil -addstore -f Root "%USERPROFILE%\\Downloads\\wgconsole-block-page-ca.crt"',
  },
]

export const Route = createFileRoute('/_authenticated/domain-rules')({
  component: DomainRulesPage,
})

export function DomainRulesPage() {
  const [showAddModal, setShowAddModal] = useState(false)
  const [scope, setScope] = useState<'global' | 'user'>('global')
  const [target, setTarget] = useState<'domain' | 'group'>('domain')
  const [domain, setDomain] = useState('')
  const [groupId, setGroupId] = useState('')
  const [userId, setUserId] = useState('')
  const [testDomain, setTestDomain] = useState('')

  // Block page certificate install-instructions modal.
  const [showCertModal, setShowCertModal] = useState(false)
  const [certPlatform, setCertPlatform] = useState<CertPlatform>('ios')
  const [copiedCertCommand, setCopiedCertCommand] = useState('')

  const copyCertCommand = async (command: string) => {
    try {
      await navigator.clipboard?.writeText(command)
      setCopiedCertCommand(command)
      window.setTimeout(() => setCopiedCertCommand(''), 2000)
    } catch {
      // Clipboard unavailable (or permission denied) — the command is selectable.
    }
  }

  const activeCertPlatform = CERT_PLATFORMS.find((platform) => platform.id === certPlatform)

  // Domain groups card + create/edit modal.
  const [showGroupModal, setShowGroupModal] = useState(false)
  const [editingGroup, setEditingGroup] = useState<DomainGroup | null>(null)
  const [groupName, setGroupName] = useState('')
  const [groupDomainsText, setGroupDomainsText] = useState('')
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null)
  const [deleteGroupResult, setDeleteGroupResult] = useState<{
    name: string
    rulesRemoved: number
  } | null>(null)

  const { data: rules, isLoading, refetch } = useQuery<DomainRule[]>({
    queryKey: ['domain-rules'],
    queryFn: async () => {
      return apiJson<DomainRule[]>('/api/domain-rules')
    },
  })

  const {
    data: groupsData,
    isLoading: groupsLoading,
    isError: groupsError,
    refetch: refetchGroups,
  } = useQuery<DomainGroup[]>({
    queryKey: ['domain-groups'],
    queryFn: async () => {
      return apiJson<DomainGroup[]>('/api/domain-groups')
    },
  })
  const groups = Array.isArray(groupsData) ? groupsData : []
  const groupById = new Map(groups.map((group) => [group.id, group]))

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
    mutationFn: async (data: {
      scope: string
      user_id?: string
      domain?: string
      group_id?: string
    }) => {
      return apiJson('/api/domain-rules', { method: 'POST', body: data })
    },
    onSuccess: () => {
      setShowAddModal(false)
      setDomain('')
      setGroupId('')
      setTarget('domain')
      setUserId('')
      refetch()
      refetchGroups()
      refetchStatus()
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiJson(`/api/domain-rules/${id}`, { method: 'DELETE' })
    },
    onSuccess: () => {
      refetch()
      refetchGroups()
      refetchStatus()
    },
  })

  // Create / edit a reusable domain group (domains replaces the whole list).
  const groupMutation = useMutation({
    mutationFn: async () => {
      const body = { name: groupName.trim(), domains: parseDomains(groupDomainsText) }
      return editingGroup
        ? apiJson<DomainGroup>(`/api/domain-groups/${editingGroup.id}`, {
            method: 'PATCH',
            body,
          })
        : apiJson<DomainGroup>('/api/domain-groups', { method: 'POST', body })
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
    mutationFn: async (group: DomainGroup) => {
      return apiJson<DeleteGroupResult>(`/api/domain-groups/${group.id}`, {
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
    setTarget('domain')
    setGroupId('')
    setShowAddModal(true)
  }

  const closeAddModal = () => {
    addMutation.reset()
    setShowAddModal(false)
  }

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    // The API accepts exactly one of domain / group_id.
    const data: { scope: string; user_id?: string; domain?: string; group_id?: string } = {
      scope,
    }
    if (scope === 'user' && userId) {
      data.user_id = userId
    }
    if (target === 'group') {
      if (!groupId) return
      data.group_id = groupId
    } else {
      data.domain = domain
    }
    addMutation.mutate(data)
  }

  const handleTestDomain = (e: React.FormEvent) => {
    e.preventDefault()
    const value = testDomain.trim()
    if (!value) return
    checkMutation.mutate(value)
  }

  const openNewGroupModal = () => {
    groupMutation.reset()
    setEditingGroup(null)
    setGroupName('')
    setGroupDomainsText('')
    setDeleteGroupResult(null)
    setShowGroupModal(true)
  }

  const openEditGroupModal = (group: DomainGroup) => {
    groupMutation.reset()
    setEditingGroup(group)
    setGroupName(group.name)
    setGroupDomainsText(group.domains.join('\n'))
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
    if (!groupName.trim() || groupDomains.length === 0) return
    groupMutation.mutate()
  }

  const confirmDeleteGroup = (group: DomainGroup) => {
    const cascade =
      group.rule_count > 0 ? ` ${group.rule_count} rule(s) using it will be removed too.` : ''
    if (confirm(`Delete group "${group.name}"?${cascade}`)) {
      deleteGroupMutation.mutate(group)
    }
  }

  const active = Array.isArray(rules) ? rules : []
  const groupDomains = parseDomains(groupDomainsText)
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
            <label htmlFor="target" className={labelCls}>
              Target
            </label>
            <select
              id="target"
              className={inputCls}
              value={target}
              onChange={(e) => {
                setTarget(e.target.value as 'domain' | 'group')
                addMutation.reset()
              }}
            >
              <option value="domain">Domain</option>
              <option value="group">Domain group</option>
            </select>
          </div>

          {target === 'domain' ? (
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
          ) : (
            <div>
              <label htmlFor="groupId" className={labelCls}>
                Domain group
              </label>
              <select
                id="groupId"
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
                    {group.name} ({group.domain_count} domain
                    {group.domain_count === 1 ? '' : 's'})
                  </option>
                ))}
              </select>
              {!groupsLoading && groups.length === 0 && (
                <p className="text-zinc-500 text-xs mt-1">
                  No groups yet — create one to block many domains at once.
                </p>
              )}
            </div>
          )}

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
            <PrimaryButton
              type="submit"
              disabled={
                addMutation.isPending || (target === 'group' ? !groupId : !domain)
              }
            >
              {addMutation.isPending ? 'Adding…' : 'Add Rule'}
            </PrimaryButton>
          </div>
        </form>
      </Modal>

      {/* Create / edit a reusable group of domains. */}
      <Modal
        open={showGroupModal}
        onClose={closeGroupModal}
        title={editingGroup ? 'Edit domain group' : 'New domain group'}
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
              placeholder="YouTube"
              value={groupName}
              onChange={(e) => {
                setGroupName(e.target.value)
                groupMutation.reset()
              }}
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <label htmlFor="group-domains" className={labelCls + ' mb-0'}>
                Domains
              </label>
              <span className="text-xs text-zinc-500 tabular-nums">
                {groupDomains.length} domain{groupDomains.length === 1 ? '' : 's'}
              </span>
            </div>
            <textarea
              id="group-domains"
              rows={6}
              className={inputCls + ' font-mono text-xs'}
              placeholder={'googlevideo.com\nytimg.com\nyoutube.com'}
              value={groupDomainsText}
              onChange={(e) => {
                setGroupDomainsText(e.target.value)
                groupMutation.reset()
              }}
            />
            <p className="text-zinc-500 text-xs mt-1">
              One domain per line (commas also work). e.g.{' '}
              <code className="bg-zinc-800 px-1 rounded">googlevideo.com</code>,{' '}
              <code className="bg-zinc-800 px-1 rounded">ytimg.com</code>…
            </p>
          </div>

          {/* Server-side 400 (invalid name/domain) or 409 (duplicate name). */}
          {groupMutation.isError && (
            <p role="alert" className="text-red-400 text-sm">
              {groupMutation.error?.message || 'Failed to save group.'}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <GhostButton type="button" onClick={closeGroupModal}>
              Cancel
            </GhostButton>
            <PrimaryButton
              type="submit"
              disabled={
                groupMutation.isPending || !groupName.trim() || groupDomains.length === 0
              }
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

      <div className="border border-zinc-800 rounded-lg bg-zinc-900/50 p-6 mb-6">
        <h2 className="text-sm font-medium text-zinc-200 mb-3">How It Works</h2>
        <ul className="text-zinc-400 text-sm space-y-1.5 leading-relaxed">
          <li>• <strong className="text-zinc-200">Global rules</strong> block domains for all users</li>
          <li>• <strong className="text-zinc-200">User rules</strong> block domains for specific users only</li>
          <li>• <strong className="text-zinc-200">Domain groups</strong> block many domains with one rule</li>
          <li>• Rules use adblock-style syntax: <code className="bg-zinc-800 px-1 rounded">||example.com^</code></li>
          <li>• Subdomains are blocked automatically (e.g., <code className="bg-zinc-800 px-1 rounded">||example.com^</code> blocks example.com and *.example.com)</li>
          <li>• Changes are synced to AdGuard Home immediately</li>
        </ul>
      </div>

      {/* Block page certificate — the tunnel CA signs the HTTPS block page. */}
      <Panel title="Block page certificate" className="mb-6">
        <div className="space-y-3 px-5 pb-5">
          <p className="text-sm text-zinc-400 leading-relaxed">
            Blocked HTTPS sites show a certificate warning until this certificate is installed
            once per device. HSTS sites like YouTube won't open the block page at all without it.
          </p>
          <p className="text-xs text-zinc-500">
            Root CA: only install on devices that trust this VPN server.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <a href="/ca.crt" download className={certDownloadCls}>
              <IconDownload size={13} stroke={1.8} aria-hidden="true" />
              Download certificate
            </a>
            <button
              type="button"
              onClick={() => setShowCertModal(true)}
              className={smallButtonCls}
            >
              Install instructions
            </button>
          </div>
        </div>
      </Panel>

      {/* Install instructions: one platform at a time, short steps. */}
      <Modal
        open={showCertModal}
        onClose={() => setShowCertModal(false)}
        title="Install the block page certificate"
        className="max-w-md"
        footer={
          <GhostButton type="button" onClick={() => setShowCertModal(false)}>
            Close
          </GhostButton>
        }
      >
        <div className="space-y-3">
          <div className={tabGroupCls} role="tablist" aria-label="Platform">
            {CERT_PLATFORMS.map((platform) => (
              <button
                key={platform.id}
                type="button"
                role="tab"
                aria-selected={certPlatform === platform.id}
                onClick={() => setCertPlatform(platform.id)}
                className={toolbarTab(certPlatform === platform.id, 'bg-teal-700 text-white')}
              >
                {platform.label}
              </button>
            ))}
          </div>

          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-zinc-400 leading-relaxed">
            {(activeCertPlatform?.steps ?? []).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>

          {activeCertPlatform?.command && (
            <div className="relative">
              <pre className="overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 pr-20 text-xs leading-relaxed text-zinc-300">
                <code>{activeCertPlatform.command}</code>
              </pre>
              <button
                type="button"
                onClick={() => copyCertCommand(activeCertPlatform.command!)}
                className="absolute right-2 top-2 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
              >
                {copiedCertCommand === activeCertPlatform.command ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}

          {activeCertPlatform?.note && (
            <p className="text-xs leading-relaxed text-zinc-500">{activeCertPlatform.note}</p>
          )}

          <p className="text-xs text-zinc-500 leading-relaxed">
            Chrome/Edge use the OS certificate store; Firefox desktop has its own store
            (Settings → Certificates → Import).
          </p>

          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300 leading-relaxed">
            This certificate is a root CA: devices that trust it also trust any HTTPS site the
            VPN server signs. Only install it on devices you trust.
          </p>
        </div>
      </Modal>

      {/* Reusable groups: one rule can block every domain in a group. */}
      <Panel
        title="Domain groups"
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
            Failed to load domain groups.
          </p>
        ) : groups.length === 0 ? (
          <p className="px-5 pb-4 text-sm text-zinc-500">
            No groups yet — create one to block many domains at once.
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
                      {group.domain_count} domain{group.domain_count === 1 ? '' : 's'}
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
                      {group.domains.length === 0 ? (
                        <span className="text-xs text-zinc-500">No domains.</span>
                      ) : (
                        group.domains.map((groupDomain) => (
                          <code
                            key={groupDomain}
                            className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-400"
                          >
                            {groupDomain}
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
                  <th className={thCls}>Target</th>
                  <th className={thCls}>Scope</th>
                  <th className={thCls}>User</th>
                  <th className={thCls}>Created</th>
                  <th className={thCls + ' text-right'}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {active.map((rule) => {
                  const group = rule.group_id ? groupById.get(rule.group_id) : undefined
                  return (
                    <tr key={rule.id} className="hover:bg-zinc-800/30 transition-colors">
                      <td className={tdCls}>
                        {rule.group_id ? (
                          <span className="inline-flex flex-wrap items-center gap-1.5">
                            <span className="text-xs text-zinc-500">Group:</span>
                            <Badge tone="accent">
                              {rule.group_name || group?.name || 'group'}
                            </Badge>
                            {group && (
                              <span className="text-xs text-zinc-500">
                                {group.domain_count} domain
                                {group.domain_count === 1 ? '' : 's'}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="font-mono">{`||${rule.domain}^`}</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <Badge tone={rule.scope === 'global' ? 'accent' : 'info'}>
                          {rule.scope}
                        </Badge>
                      </td>
                      <td className={tdCls}>
                        {rule.user_full_name || rule.user_email || '—'}
                      </td>
                      <td className={tdCls}>{fmtDate(rule.created_at)}</td>
                      <td className="px-5 py-3.5 whitespace-nowrap text-right text-sm font-medium">
                        <button
                          onClick={() => deleteMutation.mutate(rule.id)}
                          className="inline-flex items-center text-sm rounded-md px-2 py-1 text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
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
      </div>
    </div>
  )
}

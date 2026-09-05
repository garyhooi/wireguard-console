import { createFileRoute } from '@tanstack/react-router'
import { apiJson } from '../../lib/api'
import { dateKey, fmtDateTime } from '../../lib/timezone'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { IconChevronDown, IconChevronRight, IconDownload, IconSearch } from '@tabler/icons-react'
import {
  Badge,
  DangerButton,
  EmptyState,
  GhostButton,
  PageHeader,
  Panel,
  Skeleton,
  tableCls,
  thCls,
  toolbarTab,
  tabGroupCls,
  searchCls,
} from '../../lib/ui'

interface SummaryRow {
  scope: 'user' | 'peer'
  id: string
  name: string
  email: string
  peers: number
  allowed: number
  blocked: number
  last_seen: string | null
}

interface SummaryResponse {
  scope: string
  from: string
  to: string
  rows: SummaryRow[]
}

interface WebRecord {
  id: number
  peer_id: string
  peer_name: string
  user_id: string | null
  user_name: string
  user_email: string
  client_ip: string
  host: string
  base_domain: string
  blocked: boolean
  reason: string | null
  queried_at: string
}

interface RecordsResponse {
  count: number
  rows: WebRecord[]
}

interface Me {
  id: string
  role: string
}

interface Selectable {
  id: string
  label: string
}

export const Route = createFileRoute('/_authenticated/web-activity')({
  component: WebActivityPage,
})


const PURGE_OPTIONS = [
  { days: 7, label: 'Older than 7 days' },
  { days: 30, label: 'Older than 30 days' },
  { days: 90, label: 'Older than 90 days' },
]

type Scope = 'user' | 'peer'
type StatusFilter = 'all' | 'allowed' | 'blocked'

const today = () => dateKey()
const daysAgo = (n: number) => dateKey(-n)

export function WebActivityPage() {
  const queryClient = useQueryClient()
  const [scope, setScope] = useState<Scope>('user')
  const [fromDate, setFromDate] = useState(() => daysAgo(6))
  const [toDate, setToDate] = useState(today)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [entityId, setEntityId] = useState('') // narrow the summary to one user/peer
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(200)
  // Which summary row's raw records are expanded (at most one).
  const [detail, setDetail] = useState<{ scope: Scope; id: string } | null>(null)
  const [purgeDays, setPurgeDays] = useState(30)
  const [actionMsg, setActionMsg] = useState('')
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => setQ(qInput.trim()), 300)
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
    }
  }, [qInput])

  const { data: me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: async () => {
      return apiJson<Me>('/api/admins/me')
    },
  })
  const isSuperAdmin = me?.role === 'super_admin'

  const { data: users } = useQuery<Selectable[]>({
    queryKey: ['users'],
    queryFn: async () => {
      const rows = await apiJson<Array<{ id: string; email: string; full_name: string | null }>>('/api/users')
      return rows.map((u) => ({ id: u.id, label: u.full_name || u.email }))
    },
  })

  const { data: peers } = useQuery<Selectable[]>({
    queryKey: ['peers'],
    queryFn: async () => {
      const rows = await apiJson<Array<{ id: string; name: string }>>('/api/peers')
      return rows.map((p) => ({ id: p.id, label: p.name }))
    },
  })

  const summaryQuery = useQuery<SummaryResponse>({
    queryKey: ['web-activity-summary', scope, fromDate, toDate],
    queryFn: async () => {
      const qs = new URLSearchParams({ scope, from: fromDate, to: toDate })
      return apiJson<SummaryResponse>(`/api/web-activity/summary?${qs}`)
    },
    refetchInterval: 30000,
  })

  // The raw-records filter bundle shared by the expanded-row detail and the
  // CSV export (date window + allowed/blocked + domain search + row cap).
  const recordParams = useMemo(() => {
    const p: Record<string, string> = { from: fromDate, to: toDate, limit: String(limit) }
    if (status !== 'all') p.blocked = status
    if (q) p.q = q
    return p
  }, [fromDate, toDate, status, q, limit])

  // Raw records for the expanded summary row, or — when nothing is expanded —
  // for the whole current filter window (kept warm so Export CSV is instant).
  const detailQuery = useQuery<RecordsResponse>({
    queryKey: ['web-activity-records', scope, detail?.id ?? '', recordParams],
    queryFn: async () => {
      const p = { ...recordParams }
      if (detail) p[scope === 'user' ? 'user_id' : 'peer_id'] = detail.id
      return apiJson<RecordsResponse>(`/api/web-activity?${new URLSearchParams(p)}`)
    },
    refetchInterval: 30000,
  })

  const purgeMutation = useMutation({
    mutationFn: async (days?: number) => {
      const qs = days ? `?days=${days}` : ''
      return apiJson<{ deleted: number; scope: string }>(`/api/web-activity${qs}`, { method: 'DELETE' })
    },
    onSuccess: (data: { deleted: number; scope: string }) => {
      setActionMsg(
        data.scope === 'all'
          ? `All web-activity records cleared (${data.deleted} rows removed).`
          : `Removed ${data.deleted} web-activity rows older than the cutoff.`,
      )
      queryClient.invalidateQueries({ queryKey: ['web-activity-summary'] })
      queryClient.invalidateQueries({ queryKey: ['web-activity-records'] })
      setDetail(null)
    },
    onError: (e: Error) => setActionMsg(`Purge failed: ${e.message}`),
  })

  const doPurge = (days?: number) => {
    const label = days ? `web-activity records older than ${days} days` : 'ALL web-activity records'
    if (confirm(`Delete ${label}?\n\nThis permanently removes browsing records and cannot be undone.`)) {
      setActionMsg('')
      purgeMutation.mutate(days)
    }
  }

  const toggleDetail = (row: SummaryRow) => {
    setDetail((prev) => (prev && prev.id === row.id ? null : { scope: row.scope, id: row.id }))
  }

  const exportCsv = () => {
    const rows = detailQuery.data?.rows ?? []
    if (rows.length === 0) return
    const head = 'When,User,Peer,Client IP,Domain,Status'
    const lines = rows.map((r) =>
      [
        r.queried_at,
        r.user_email || r.user_name || r.peer_name,
        r.peer_name,
        r.client_ip,
        r.host,
        r.blocked ? `blocked${r.reason ? ` (${r.reason})` : ''}` : 'allowed',
      ]
        .map((v) => (v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v))
        .join(','),
    )
    const blob = new Blob([[head, ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `web-activity-${scope}${detail ? '-detail' : ''}-${fromDate}_${toDate}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const summaryRows = useMemo(() => {
    let rows = summaryQuery.data?.rows ?? []
    if (entityId) rows = rows.filter((r) => r.id === entityId)
    return rows
  }, [summaryQuery.data, entityId])

  const entityOptions = scope === 'user' ? users ?? [] : peers ?? []
  const records = detailQuery.data?.rows ?? []

  return (
    <div>
      <PageHeader
        title="Web Activity"
        description="Per-VPN-user and per-peer web activity from the DNS queries each peer sends through the tunnel's AdGuard filter. Blocked rows are domains the filter refused; everything else was allowed. Data is imported from AdGuard Home every 30 seconds."
      />

      {/* Toolbar: scope + filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className={tabGroupCls}>
          {(['user', 'peer'] as const).map((sc) => (
            <button
              key={sc}
              onClick={() => {
                setScope(sc)
                setEntityId('')
                setDetail(null)
              }}
              className={toolbarTab(scope === sc, 'bg-teal-700 text-white')}
            >
              {sc === 'user' ? 'By VPN user' : 'By peer'}
            </button>
          ))}
        </div>

        <select
          value={entityId}
          onChange={(e) => {
            setEntityId(e.target.value)
            setDetail(null)
          }}
          className="bg-zinc-800/60 border border-zinc-700 rounded-md px-2 py-1.5 text-sm text-zinc-100"
        >
          <option value="">All {scope === 'user' ? 'VPN users' : 'peers'}</option>
          {entityOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>

        <div className={tabGroupCls}>
          {(['all', 'allowed', 'blocked'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={toolbarTab(status === s, 'bg-zinc-700 text-white')}
            >
              {s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        <label className="text-xs text-zinc-500">
          From{' '}
          <input
            type="date"
            value={fromDate}
            max={toDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="bg-zinc-800/60 border border-zinc-700 rounded-md px-2 py-1.5 text-sm text-zinc-100"
          />
        </label>
        <label className="text-xs text-zinc-500">
          To{' '}
          <input
            type="date"
            value={toDate}
            min={fromDate}
            onChange={(e) => setToDate(e.target.value)}
            className="bg-zinc-800/60 border border-zinc-700 rounded-md px-2 py-1.5 text-sm text-zinc-100"
          />
        </label>

        <label className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
          <IconSearch size={13} stroke={1.6} aria-hidden="true" />
          <input
            type="text"
            placeholder="Filter domains…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            className={searchCls + ' w-52'}
          />
        </label>

        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          title="Max rows per records view"
          className="bg-zinc-800/60 border border-zinc-700 rounded-md px-2 py-1.5 text-sm text-zinc-100"
        >
          {[200, 500, 1000].map((n) => (
            <option key={n} value={n}>
              {n} rows
            </option>
          ))}
        </select>

        <button
          onClick={exportCsv}
          disabled={records.length === 0}
          className="inline-flex items-center gap-2 bg-transparent border border-zinc-700 hover:border-zinc-500 text-zinc-300 text-sm font-medium py-1.5 px-3 rounded-md disabled:opacity-40 transition-colors"
        >
          <IconDownload size={15} stroke={1.6} aria-hidden="true" />
          Export CSV
        </button>
      </div>

      {/* Summary table with expandable per-entity record detail */}
      <Panel
        title={scope === 'user' ? 'VPN users' : 'Peers'}
        description={`Allowed vs blocked lookups ${fromDate} → ${toDate}. Expand a row to inspect its records.`}
      >
        {summaryQuery.isLoading ? (
          <div className="p-5 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : summaryRows.length === 0 ? (
          <EmptyState
            title="No web activity in this range"
            hint="Records come from AdGuard Home's query log once peers browse through the tunnel. Widen the date range or wait for traffic."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 bg-zinc-800/40">
                  <th className={thCls} />
                  <th className={thCls}>{scope === 'user' ? 'VPN user' : 'Peer'}</th>
                  {scope === 'user' && <th className={thCls}>Peers</th>}
                  <th className={thCls + ' text-right'}>Allowed</th>
                  <th className={thCls + ' text-right'}>Blocked</th>
                  <th className={thCls}>Last activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {summaryRows.map((row) => {
                  const open = detail?.id === row.id && detail.scope === row.scope
                  return (
                    <EntityRow
                      key={`${row.scope}:${row.id}`}
                      row={row}
                      open={open}
                      onToggle={() => toggleDetail(row)}
                      records={open ? records : []}
                      recordsLoading={open && detailQuery.isFetching}
                      statusFilter={status}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Housekeeping — super_admin only */}
      {isSuperAdmin && (
        <Panel title="Housekeeping" className="mt-6">
          <div className="px-5 py-4">
            <p className="text-sm text-zinc-500 mb-4 max-w-2xl">
              Raw browsing records grow with peer traffic. The worker purges rows older than the
              retention window (<code className="font-mono">BROWSE_RETENTION_DAYS</code>, default
              30 days) every night; here you can remove history immediately to reclaim database
              storage. Purges are recorded in the audit log.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <select
                value={purgeDays}
                onChange={(e) => setPurgeDays(Number(e.target.value))}
                className="bg-zinc-800/60 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-teal-500"
              >
                {PURGE_OPTIONS.map((o) => (
                  <option key={o.days} value={o.days}>
                    {o.label}
                  </option>
                ))}
              </select>
              <GhostButton disabled={purgeMutation.isPending} onClick={() => doPurge(purgeDays)}>
                {purgeMutation.isPending ? 'Deleting…' : 'Delete old records'}
              </GhostButton>
              <span className="text-xs text-zinc-600">or</span>
              <DangerButton
                disabled={purgeMutation.isPending}
                onClick={() => doPurge()}
                className="border-0 py-1 px-2 text-xs"
              >
                Clear entire web activity
              </DangerButton>
            </div>
            {actionMsg && <p className="text-teal-400 text-sm mt-3">{actionMsg}</p>}
          </div>
        </Panel>
      )}

      <p className="mt-4 text-xs text-zinc-600 max-w-3xl leading-relaxed">
        Web activity is domain-level only: WireGuard encrypts full URLs and page content, so the
        console records which domains each peer resolved (allowed or blocked by the filter) —
        never the pages themselves.
      </p>
    </div>
  )
}

function EntityRow({
  row,
  open,
  onToggle,
  records,
  recordsLoading,
  statusFilter,
}: {
  row: SummaryRow
  open: boolean
  onToggle: () => void
  records: WebRecord[]
  recordsLoading: boolean
  statusFilter: StatusFilter
}) {
  const total = row.allowed + row.blocked
  const blockPct = total > 0 ? Math.round((row.blocked / total) * 100) : 0
  const colSpan = row.scope === 'user' ? 6 : 5
  return (
    <>
      <tr className="hover:bg-zinc-800/30 transition-colors cursor-pointer" onClick={onToggle}>
        <td className="px-5 py-3 w-8 text-zinc-500">
          {open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
        </td>
        <td className="px-5 py-3 text-sm text-zinc-200">
          {row.name}
          {row.email && row.email !== row.name && (
            <span className="block text-xs text-zinc-500">{row.email}</span>
          )}
        </td>
        {row.scope === 'user' && (
          <td className="px-5 py-3 text-sm text-zinc-500 font-mono tabular-nums">{row.peers}</td>
        )}
        <td className="px-5 py-3 text-right text-sm text-teal-400 font-mono tabular-nums">
          {row.allowed.toLocaleString()}
        </td>
        <td className="px-5 py-3 text-right">
          <span className="text-sm text-red-400 font-mono tabular-nums">
            {row.blocked.toLocaleString()}
          </span>
          {row.blocked > 0 && (
            <span className="ml-2 text-[11px] text-zinc-500 tabular-nums">({blockPct}%)</span>
          )}
        </td>
        <td className="px-5 py-3 text-sm text-zinc-500 font-mono tabular-nums whitespace-nowrap">
          {row.last_seen ? fmtDateTime(row.last_seen) : '—'}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={colSpan} className="p-0 border-t border-zinc-800/60">
            <div className="bg-zinc-950/40 px-6 py-4">
              {recordsLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : records.length === 0 ? (
                <p className="text-sm text-zinc-500">
                  No records match the current filters ({statusFilter === 'all' ? 'all' : statusFilter}{' '}
                  lookups in the selected range).
                </p>
              ) : (
                <div className="max-h-96 overflow-y-auto border border-zinc-800 rounded-lg">
                  <table className="min-w-full divide-y divide-zinc-800/60 text-sm">
                    <thead className="bg-zinc-900/60 sticky top-0">
                      <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500">
                        <th className={thCls}>When</th>
                        <th className={thCls}>Domain</th>
                        {row.scope === 'user' && <th className={thCls}>Peer</th>}
                        <th className={thCls}>Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/40">
                      {records.map((rec) => (
                        <tr key={rec.id} className="hover:bg-zinc-800/20">
                          <td className="px-5 py-2 text-xs text-zinc-500 font-mono tabular-nums whitespace-nowrap">
                            {fmtDateTime(rec.queried_at)}
                          </td>
                          <td className="px-5 py-2 text-zinc-200 font-mono">{rec.host}</td>
                          {row.scope === 'user' && (
                            <td className="px-5 py-2 text-zinc-500">{rec.peer_name}</td>
                          )}
                          <td className="px-5 py-2 whitespace-nowrap">
                            {rec.blocked ? (
                              <Badge tone="bad">Blocked{rec.reason ? ` · ${rec.reason}` : ''}</Badge>
                            ) : (
                              <Badge tone="good">Allowed</Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

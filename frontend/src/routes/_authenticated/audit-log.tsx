import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  DangerButton,
  GhostButton,
  PageHeader,
  Panel,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
} from '../../lib/ui'

interface AuditLog {
  id: number
  actor_admin_id: string | null
  action: string
  target_type: string | null
  target_id: string | null
  metadata: string | null
  ip_address: string | null
  created_at: string
}

interface Me {
  id: string
  role: string
}

export const Route = createFileRoute('/_authenticated/audit-log')({
  component: AuditLogPage,
})

const auth = { Authorization: localStorage.getItem('token')! }

const PURGE_OPTIONS = [
  { days: 30, label: 'Older than 30 days' },
  { days: 90, label: 'Older than 90 days' },
  { days: 180, label: 'Older than 180 days' },
]

function AuditLogPage() {
  const queryClient = useQueryClient()
  const [purgeDays, setPurgeDays] = useState(30)
  const [actionMsg, setActionMsg] = useState('')

  const { data: logs, isLoading } = useQuery<AuditLog[]>({
    queryKey: ['audit-logs'],
    queryFn: async () => {
      const res = await fetch('/api/audit-logs', { headers: auth })
      if (!res.ok) throw new Error('Failed to fetch audit logs')
      return res.json()
    },
    refetchInterval: 30000,
  })

  const { data: me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: async () => {
      const res = await fetch('/api/admins/me', { headers: auth })
      if (!res.ok) throw new Error('Failed to load profile')
      return res.json()
    },
  })

  const isSuperAdmin = me?.role === 'super_admin'

  const purgeMutation = useMutation({
    mutationFn: async (mode: { days?: number }) => {
      const qs = mode.days ? `?days=${mode.days}` : ''
      const res = await fetch(`/api/audit-logs${qs}`, { method: 'DELETE', headers: auth })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to purge audit logs')
      }
      return res.json()
    },
    onSuccess: (data: { deleted: number; scope: string }) => {
      setActionMsg(
        data.scope === 'all'
          ? `All audit logs cleared (${data.deleted} rows removed).`
          : `Removed ${data.deleted} audit-log rows older than the cutoff.`,
      )
      queryClient.invalidateQueries({ queryKey: ['audit-logs'] })
    },
    onError: (e: Error) => setActionMsg(`Purge failed: ${e.message}`),
  })

  const doPurge = (days?: number) => {
    const label = days ? `audit logs older than ${days} days` : 'ALL audit logs'
    if (confirm(`Delete ${label}?\n\nThis cannot be undone.`)) {
      setActionMsg('')
      purgeMutation.mutate(days ? { days } : {})
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
        title="Audit Log"
        description="Immutable record of admin actions across the console. Shown newest-first (latest 100)."
      />

      {isSuperAdmin && (
        <Panel title="Housekeeping" className="mb-6">
          <div className="px-5 py-4">
            <p className="text-sm text-zinc-500 mb-4 max-w-2xl">
              Audit logs accumulate over time and can grow large. As super admin you can delete
              older entries — the cleanup action itself is always recorded.
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
                {purgeMutation.isPending ? 'Deleting…' : 'Delete old logs'}
              </GhostButton>
              <span className="text-xs text-zinc-600">or</span>
              <DangerButton
                disabled={purgeMutation.isPending}
                onClick={() => doPurge()}
                className="border-0 py-1 px-2 text-xs"
              >
                Clear entire audit log
              </DangerButton>
            </div>
            {actionMsg && <p className="text-teal-400 text-sm mt-3">{actionMsg}</p>}
          </div>
        </Panel>
      )}

      <div className={tableWrapCls}>
        <div className="overflow-x-auto">
          <table className={tableCls}>
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 bg-zinc-800/40">
                <th className={thCls}>Timestamp</th>
                <th className={thCls}>Action</th>
                <th className={thCls}>Target</th>
                <th className={thCls}>IP Address</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {logs?.map((log) => (
                <tr key={log.id} className="hover:bg-zinc-800/30 transition-colors">
                  <td className={tdCls + ' font-mono tabular-nums'}>
                    {new Date(log.created_at).toLocaleString()}
                  </td>
                  <td className="px-5 py-3.5 whitespace-nowrap text-sm text-zinc-200">{log.action}</td>
                  <td className={tdCls}>
                    {log.target_type ? `${log.target_type}: ${log.target_id}` : '—'}
                  </td>
                  <td className={tdCls + ' font-mono'}>{log.ip_address || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

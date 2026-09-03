import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

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

export const Route = createFileRoute('/_authenticated/audit-log')({
  component: AuditLogPage,
})

function AuditLogPage() {
  const { data: logs, isLoading } = useQuery<AuditLog[]>({
    queryKey: ['audit-logs'],
    queryFn: async () => {
      const res = await fetch('/api/audit-logs', {
        headers: { Authorization: localStorage.getItem('token')! },
      })
      if (!res.ok) throw new Error('Failed to fetch audit logs')
      return res.json()
    },
    refetchInterval: 30000,
  })

  if (isLoading) {
    return <div className="text-neutral-400">Loading...</div>
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">Audit Log</h1>

      <div className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-neutral-800">
          <thead className="bg-neutral-800">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Timestamp
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Action
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Target
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                IP Address
              </th>
            </tr>
          </thead>
          <tbody className="bg-neutral-900 divide-y divide-neutral-800">
            {logs?.map((log) => (
              <tr key={log.id}>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400">
                  {new Date(log.created_at).toLocaleString()}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-white">
                  {log.action}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400">
                  {log.target_type ? `${log.target_type}: ${log.target_id}` : '-'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400 font-mono">
                  {log.ip_address || '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

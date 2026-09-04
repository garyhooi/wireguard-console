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

interface Admin {
  id: string
  email: string
  role: string
  totp_enabled: boolean
  status: string
  created_at: string
}

export const Route = createFileRoute('/_authenticated/admins')({
  component: AdminsPage,
})

const auth = { Authorization: localStorage.getItem('token')! }

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super admin',
  admin: 'Admin',
  auditor: 'Auditor',
}

function AdminsPage() {
  const queryClient = useQueryClient()
  const [showInvite, setShowInvite] = useState(false)
  const [form, setForm] = useState({ email: '', role: 'admin' })
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const { data: admins, isLoading } = useQuery<Admin[]>({
    queryKey: ['admins'],
    queryFn: async () => {
      const res = await fetch('/api/admins', { headers: auth })
      if (!res.ok) {
        if (res.status === 403) throw new Error('Only super_admins can view admin management')
        throw new Error('Failed to fetch admins')
      }
      return res.json()
    },
  })

  const inviteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/admins', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to invite admin')
      }
    },
    onSuccess: () => {
      setShowInvite(false)
      setForm({ email: '', role: 'admin' })
      setNotice('Admin invited — initial credentials are emailed when SMTP is configured.')
      setError('')
      queryClient.invalidateQueries({ queryKey: ['admins'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const roleMutation = useMutation({
    mutationFn: async (a: { id: string; role: string }) => {
      const res = await fetch(`/api/admins/${a.id}`, {
        method: 'PATCH',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: a.role }),
      })
      if (!res.ok) throw new Error('Failed to update role')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admins'] }),
    onError: (e: Error) => setError(e.message),
  })

  const resetPwMutation = useMutation({
    mutationFn: async (a: Admin) => {
      const res = await fetch(`/api/admins/${a.id}/reset-password`, { method: 'POST', headers: auth })
      if (!res.ok) throw new Error('Failed to reset password')
      return res.json()
    },
    onSuccess: (data: { password: string }, a: Admin) => {
      setNotice(`Temporary password for ${a.email}: ${data.password}  (emailed if SMTP is configured)`)
      setError('')
    },
    onError: (e: Error) => setError(e.message),
  })

  const disableMutation = useMutation({
    mutationFn: async (a: Admin) => {
      const res = await fetch(`/api/admins/${a.id}`, { method: 'DELETE', headers: auth })
      if (!res.ok) throw new Error('Failed to disable admin')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admins'] }),
    onError: (e: Error) => setError(e.message),
  })

  return (
    <div>
      <PageHeader
        title="Admins"
        description="People who operate this console (separate from VPN users — those live under VPN Users and only receive tunnel configs)."
        actions={
          <PrimaryButton onClick={() => setShowInvite(true)}>Invite Admin</PrimaryButton>
        }
      />

      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
      {notice && <p className="text-teal-400 text-sm mb-3">{notice}</p>}

      {showInvite && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h2 className="text-lg font-semibold text-zinc-100 mb-4">Invite Admin</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                inviteMutation.mutate()
              }}
              className="space-y-4"
            >
              <div>
                <label className={labelCls}>Email</label>
                <input
                  type="email"
                  required
                  className={inputCls}
                  placeholder="operator@company.com"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                />
              </div>
              <div>
                <label className={labelCls}>Role</label>
                <select
                  className="w-full bg-zinc-800/60 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-100"
                  value={form.role}
                  onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                >
                  <option value="admin">Admin — manage users, peers, servers</option>
                  <option value="super_admin">Super admin — everything</option>
                  <option value="auditor">Auditor — read-only</option>
                </select>
              </div>
              <p className="text-xs text-zinc-500">
                The invited admin receives temporary credentials by email and must change them in
                Profile on first login (2FA is enforced policy).
              </p>
              <div className="flex gap-3">
                <PrimaryButton type="submit" disabled={inviteMutation.isPending}>
                  {inviteMutation.isPending ? 'Inviting…' : 'Send Invite'}
                </PrimaryButton>
                <GhostButton onClick={() => setShowInvite(false)}>Cancel</GhostButton>
              </div>
            </form>
          </div>
        </div>
      )}

      <Panel>
        {isLoading ? (
          <div className="p-5 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : !admins || admins.length === 0 ? (
          <EmptyState title="No admins" hint="Only the first super_admin exists so far." />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-zinc-800/80">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-600">
                  <th className="px-5 py-2.5 font-medium">Email</th>
                  <th className="px-5 py-2.5 font-medium">Role</th>
                  <th className="px-5 py-2.5 font-medium">2FA</th>
                  <th className="px-5 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 font-medium">Created</th>
                  <th className="px-5 py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {admins?.map((a) => (
                  <tr key={a.id} className="hover:bg-zinc-800/40 transition-colors">
                    <td className="px-5 py-3 text-sm text-zinc-200">{a.email}</td>
                    <td className="px-5 py-3">
                      <select
                        className="bg-zinc-800/60 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-200"
                        value={a.role}
                        onChange={(e) => a.status === 'active' && roleMutation.mutate({ id: a.id, role: e.target.value })}
                      >
                        <option value="admin">Admin</option>
                        <option value="super_admin">Super admin</option>
                        <option value="auditor">Auditor</option>
                      </select>
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={a.totp_enabled ? 'ok' : 'warning'} />
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={a.status} />
                    </td>
                    <td className="px-5 py-3 text-sm text-zinc-500 font-mono tabular-nums">
                      {a.created_at ? new Date(a.created_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-5 py-3 text-right text-sm">
                      {a.status === 'active' ? (
                        <div className="flex justify-end gap-3">
                          <button
                            onClick={() => {
                              if (confirm(`Reset password for "${a.email}"?`)) resetPwMutation.mutate(a)
                            }}
                            className="text-teal-400 hover:text-teal-300"
                          >
                            Reset password
                          </button>
                          <button
                            onClick={() => {
                              if (confirm(`Disable admin "${a.email}"? (soft delete, role kept)`))
                                disableMutation.mutate(a)
                            }}
                            className="text-red-400 hover:text-red-300"
                          >
                            Disable
                          </button>
                        </div>
                      ) : (
                        <span className="text-zinc-600">disabled</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}
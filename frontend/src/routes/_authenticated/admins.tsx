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

interface Me {
  id: string
  email: string
  role: string
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
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState('')
  // Inline email editing state: one editor open at a time.
  const [editingId, setEditingId] = useState('')
  const [draftEmail, setDraftEmail] = useState('')

  const { data: me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: async () => {
      const res = await fetch('/api/admins/me', { headers: auth })
      if (!res.ok) throw new Error('Failed to load profile')
      return res.json()
    },
  })

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

  const emailMutation = useMutation({
    mutationFn: async (a: { id: string; email: string }) => {
      const res = await fetch(`/api/admins/${a.id}`, {
        method: 'PATCH',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: a.email }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to update email')
      }
    },
    onSuccess: (_d, a: { id: string; email: string }) => {
      const isSelf = me?.id === a.id
      setEditingId('')
      setNotice(
        isSelf
          ? 'Your email was updated. Use the new address to sign in from now on.'
          : 'Email updated.',
      )
      setError('')
      queryClient.invalidateQueries({ queryKey: ['admins'] })
      queryClient.invalidateQueries({ queryKey: ['me'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const statusMutation = useMutation({
    mutationFn: async (a: Admin) => {
      const res = await fetch(`/api/admins/${a.id}`, {
        method: 'PATCH',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: a.role, status: a.status === 'active' ? 'disabled' : 'active' }),
      })
      if (!res.ok) throw new Error('Failed to update admin status')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admins'] }),
    onError: (e: Error) => setError(e.message),
  })

  const filtered = (admins || []).filter((a) => {
    if (statusFilter !== 'all' && a.status !== statusFilter) return false
    const q = search.trim().toLowerCase()
    if (!q) return true
    return (a.email || '').toLowerCase().includes(q)
  })
  const statusCounts = (admins || []).reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] || 0) + 1
    return acc
  }, {})
  const TABS = ['all', 'active', 'disabled']

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

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setStatusFilter(tab)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                statusFilter === tab
                  ? 'bg-zinc-700 text-white'
                  : 'bg-zinc-900 text-zinc-400 hover:text-white'
              }`}
            >
              {tab === 'all' ? 'All' : tab[0].toUpperCase() + tab.slice(1)}
              <span className="ml-1 text-zinc-500">
                {tab === 'all' ? admins?.length ?? 0 : statusCounts[tab] || 0}
              </span>
            </button>
          ))}
        </div>
        <input
          type="search"
          placeholder="Search email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-zinc-800/60 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-teal-500"
        />
        <span className="text-xs text-zinc-500">{filtered.length} shown</span>
      </div>

      <Panel>
        {isLoading ? (
          <div className="p-5 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState title="No admins match this filter" hint="Adjust the filter or invite a new admin." />
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
                {filtered.map((a) => (
                  <tr key={a.id} className="hover:bg-zinc-800/40 transition-colors">
                    <td className="px-5 py-3 text-sm">
                      {editingId === a.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="email"
                            autoFocus
                            required
                            className="w-56 bg-zinc-800/60 border border-zinc-700 rounded-md px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-teal-500"
                            value={draftEmail}
                            onChange={(e) => setDraftEmail(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && draftEmail.trim()) {
                                emailMutation.mutate({ id: a.id, email: draftEmail.trim() })
                              } else if (e.key === 'Escape') {
                                setEditingId('')
                                setDraftEmail('')
                              }
                            }}
                          />
                          <button
                            onClick={() => emailMutation.mutate({ id: a.id, email: draftEmail.trim() })}
                            disabled={!draftEmail.trim() || emailMutation.isPending}
                            className="text-teal-400 hover:text-teal-300 disabled:opacity-40"
                            aria-label="Save email"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => {
                              setEditingId('')
                              setDraftEmail('')
                            }}
                            className="text-zinc-500 hover:text-zinc-300"
                            aria-label="Cancel edit"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <span className="flex items-center gap-2 text-zinc-200">
                          {a.email}
                          {me?.id === a.id && (
                            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-teal-500/10 text-teal-400 border border-teal-500/20">
                              You
                            </span>
                          )}
                          {a.status === 'active' && (
                            <button
                              onClick={() => {
                                setEditingId(a.id)
                                setDraftEmail(a.email)
                              }}
                              className="text-zinc-600 hover:text-teal-400 transition-colors"
                              aria-label={`Edit email for ${a.email}`}
                            >
                              Edit
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <select
                        className="bg-zinc-800/60 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed"
                        value={a.role}
                        disabled={me?.id === a.id}
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
                      <div className="flex justify-end gap-3">
                        {a.status === 'active' ? (
                          <>
                            <button
                              onClick={() => {
                                if (confirm(`Reset password for "${a.email}"?`)) resetPwMutation.mutate(a)
                              }}
                              className="text-teal-400 hover:text-teal-300"
                            >
                              Reset password
                            </button>
                            {me?.id !== a.id && (
                              <button
                                onClick={() => {
                                  if (confirm(`Disable admin "${a.email}"?`)) statusMutation.mutate(a)
                                }}
                                className="text-red-400 hover:text-red-300"
                              >
                                Disable
                              </button>
                            )}
                          </>
                        ) : (
                          <button
                            onClick={() => statusMutation.mutate(a)}
                            className="text-teal-400 hover:text-teal-300"
                          >
                            Enable
                          </button>
                        )}
                      </div>
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
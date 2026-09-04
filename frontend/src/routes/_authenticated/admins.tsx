import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { IconMailPlus, IconUserPlus } from '@tabler/icons-react'
import {
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
  toolbarCls,
  tabGroupCls,
  toolbarTab,
  searchCls,
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
          <PrimaryButton onClick={() => setShowInvite(true)}>
            <IconUserPlus size={16} stroke={1.6} aria-hidden="true" />
            Invite Admin
          </PrimaryButton>
        }
      />

      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
      {notice && <p className="text-teal-400 text-sm mb-3">{notice}</p>}

      <Modal
        open={showInvite}
        onClose={() => setShowInvite(false)}
        title="Invite Admin"
        className="max-w-md"
      >
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
            <select className={inputCls} value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
              <option value="admin">Admin — manage users, peers, servers</option>
              <option value="super_admin">Super admin — everything</option>
              <option value="auditor">Auditor — read-only</option>
            </select>
          </div>
          <p className="text-xs text-zinc-500">
            The invited admin receives temporary credentials by email and must change them in
            Profile on first login (2FA is enforced policy).
          </p>
          <div className="flex justify-end gap-3 pt-2">
            <GhostButton onClick={() => setShowInvite(false)}>Cancel</GhostButton>
            <PrimaryButton type="submit" disabled={inviteMutation.isPending}>
              {inviteMutation.isPending ? 'Inviting…' : 'Send Invite'}
            </PrimaryButton>
          </div>
        </form>
      </Modal>

      <div className={toolbarCls}>
        <div className={tabGroupCls}>
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setStatusFilter(tab)}
              className={toolbarTab(statusFilter === tab, 'bg-zinc-700 text-white')}
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
          className={searchCls}
        />
        <span className="text-xs text-zinc-500">{filtered.length} shown</span>
      </div>

      <div className={tableWrapCls}>
        {isLoading ? (
          <div className="p-5 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState title="No admins match this filter" hint="Adjust the filter or invite a new admin." />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 bg-zinc-800/40">
                  <th className={thCls}>Email</th>
                  <th className={thCls}>Role</th>
                  <th className={thCls}>2FA</th>
                  <th className={thCls}>Status</th>
                  <th className={thCls}>Created</th>
                  <th className={thCls + ' text-right'}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {filtered.map((a) => (
                  <tr key={a.id} className="hover:bg-zinc-800/30 transition-colors">
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
                            <Badge tone="accent" label="you">
                              You
                            </Badge>
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
                        className="bg-zinc-800/60 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-teal-500"
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
                    <td className={tdCls + ' font-mono tabular-nums'}>
                      {a.created_at ? new Date(a.created_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-5 py-3 text-right text-sm">
                      <div className="flex justify-end gap-1">
                        {a.status === 'active' ? (
                          <>
                            <button
                              onClick={() => {
                                if (confirm(`Reset password for "${a.email}"?`)) resetPwMutation.mutate(a)
                              }}
                              className="inline-flex items-center text-sm rounded-md px-2 py-1 text-teal-400 hover:text-teal-300 hover:bg-teal-500/10 transition-colors"
                            >
                              Reset password
                            </button>
                            {me?.id !== a.id && (
                              <button
                                onClick={() => {
                                  if (confirm(`Disable admin "${a.email}"?`)) statusMutation.mutate(a)
                                }}
                                className="inline-flex items-center text-sm rounded-md px-2 py-1 text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                              >
                                Disable
                              </button>
                            )}
                          </>
                        ) : (
                          <button
                            onClick={() => statusMutation.mutate(a)}
                            className="inline-flex items-center text-sm rounded-md px-2 py-1 text-teal-400 hover:text-teal-300 hover:bg-teal-500/10 transition-colors"
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
      </div>
    </div>
  )
}

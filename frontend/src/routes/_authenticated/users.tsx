import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { IconCopy, IconMailPlus } from '@tabler/icons-react'
import {
  Badge,
  EmptyState,
  GhostButton,
  Modal,
  PrimaryButton,
  Skeleton,
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

const authH = { Authorization: localStorage.getItem('token')! }

interface User {
  id: string
  email: string
  full_name: string
  status: string
  invited_at: string | null
  activated_at: string | null
  created_at: string
}

export const Route = createFileRoute('/_authenticated/users')({
  component: UsersPage,
})

const USER_TONE: Record<string, 'good' | 'warn' | 'info' | 'bad' | 'neutral'> = {
  active: 'good',
  invited: 'info',
  suspended: 'warn',
  removed: 'bad',
  disabled: 'bad',
}

function UsersPage() {
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [inviteLink, setInviteLink] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [copied, setCopied] = useState(false)

  const { data: smtp } = useQuery<{ configured: boolean }>({
    queryKey: ['smtp-config'],
    queryFn: async () => {
      const res = await fetch('/api/config/smtp', {
        headers: { Authorization: localStorage.getItem('token')! },
      })
      if (!res.ok) throw new Error('Failed to fetch SMTP config')
      return res.json()
    },
  })

  const { data: users, isLoading, refetch } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await fetch('/api/users', {
        headers: { Authorization: localStorage.getItem('token')! },
      })
      if (!res.ok) throw new Error('Failed to fetch users')
      return res.json()
    },
  })

  const inviteMutation = useMutation({
    mutationFn: async (data: { email: string; full_name: string }) => {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: localStorage.getItem('token')!,
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to invite user')
      return res.json()
    },
    onSuccess: (data) => {
      setInviteLink(data.invite_link || '')
      setCopied(false)
      // Keep the modal open so the invite link can be copied; the list
      // refreshes underneath.
      refetch()
    },
  })

  const suspendMutation = useMutation({
    mutationFn: async (u: User) => {
      const res = await fetch(`/api/users/${u.id}/suspend`, { method: 'POST', headers: authH })
      if (!res.ok) throw new Error('Failed to suspend user')
    },
    onSuccess: () => refetch(),
  })
  const resumeMutation = useMutation({
    mutationFn: async (u: User) => {
      const res = await fetch(`/api/users/${u.id}/resume`, { method: 'POST', headers: authH })
      if (!res.ok) throw new Error('Failed to resume user')
    },
    onSuccess: () => refetch(),
  })
  const removeMutation = useMutation({
    mutationFn: async (u: User) => {
      const res = await fetch(`/api/users/${u.id}`, { method: 'DELETE', headers: authH })
      if (!res.ok) throw new Error('Failed to remove user')
    },
    onSuccess: () => refetch(),
  })

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault()
    inviteMutation.mutate({ email: inviteEmail, full_name: inviteName })
  }

  const copyLink = async () => {
    if (!inviteLink) return
    try {
      await navigator.clipboard.writeText(inviteLink)
      setCopied(true)
    } catch {
      // Fallback for non-secure contexts
      const el = document.createElement('textarea')
      el.value = inviteLink
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setCopied(true)
    }
  }

  const filtered = (users || []).filter((u) => {
    if (statusFilter !== 'all' && u.status !== statusFilter) return false
    const q = search.trim().toLowerCase()
    if (!q) return true
    return (u.email || '').toLowerCase().includes(q) || (u.full_name || '').toLowerCase().includes(q)
  })
  const statusCounts = (users || []).reduce<Record<string, number>>((acc, u) => {
    acc[u.status] = (acc[u.status] || 0) + 1
    return acc
  }, {})
  const TABS = ['all', 'invited', 'active', 'suspended', 'removed']

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight text-zinc-100">VPN Users</h1>
          <p className="mt-1 text-sm text-zinc-500">
            People who receive tunnel configs — separate from the admins who operate this console.
          </p>
        </div>
        <PrimaryButton onClick={() => setShowInviteModal(true)}>
          <IconMailPlus size={16} stroke={1.6} aria-hidden="true" />
          Invite User
        </PrimaryButton>
      </div>

      <Modal
        open={showInviteModal}
        onClose={() => setShowInviteModal(false)}
        title="Invite User"
        className="max-w-md"
      >
        <form onSubmit={handleInvite} className="space-y-4">
          <div>
            <label htmlFor="inviteEmail" className={labelCls}>
              Email
            </label>
            <input
              id="inviteEmail"
              type="email"
              required
              className={inputCls}
              placeholder="user@example.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="inviteName" className={labelCls}>
              Full Name
            </label>
            <input
              id="inviteName"
              type="text"
              required
              className={inputCls}
              placeholder="John Doe"
              value={inviteName}
              onChange={(e) => setInviteName(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-3">
            <GhostButton type="button" onClick={() => setShowInviteModal(false)}>
              Cancel
            </GhostButton>
            <PrimaryButton type="submit" disabled={inviteMutation.isPending || !!inviteLink}>
              {inviteMutation.isPending ? 'Creating…' : 'Invite User'}
            </PrimaryButton>
          </div>
        </form>

        {inviteLink && (
          <div className="mt-4 border border-zinc-700 rounded-md p-4">
            {smtp?.configured ? (
              <p className="text-sm text-zinc-300 mb-2">
                Invite email queued — the link is also here if you want to share it directly:
              </p>
            ) : (
              <p className="text-sm text-amber-300 mb-2">
                SMTP is not configured, so the invite email will not be sent. Share this invite
                link manually:
              </p>
            )}
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={inviteLink}
                onFocus={(e) => e.target.select()}
                className={`${inputCls} font-mono text-sm`}
              />
              <GhostButton type="button" onClick={copyLink} className="shrink-0">
                <IconCopy size={15} stroke={1.6} aria-hidden="true" />
                {copied ? 'Copied' : 'Copy'}
              </GhostButton>
            </div>
            <div className="mt-3 flex justify-end">
              <PrimaryButton
                type="button"
                onClick={() => {
                  setShowInviteModal(false)
                  setInviteLink('')
                  setInviteEmail('')
                  setInviteName('')
                }}
              >
                Done
              </PrimaryButton>
            </div>
          </div>
        )}
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
                {tab === 'all' ? users?.length ?? 0 : statusCounts[tab] || 0}
              </span>
            </button>
          ))}
        </div>
        <input
          type="search"
          placeholder="Search name or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={searchCls}
        />
        <span className="text-xs text-zinc-500">{filtered.length} shown</span>
      </div>

      {isLoading ? (
        <div className={tableWrapCls}>
          <div className="p-5 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState title="No users match this filter" hint="Adjust the filter or invite a new user." />
      ) : (
        <div className={tableWrapCls}>
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 bg-zinc-800/40">
                  <th className={thCls}>Name</th>
                  <th className={thCls}>Email</th>
                  <th className={thCls}>Status</th>
                  <th className={thCls}>Invited At</th>
                  <th className={thCls + ' text-right'}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {filtered.map((user) => (
                  <tr key={user.id} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="px-5 py-3.5 whitespace-nowrap text-sm text-zinc-200">
                      {user.full_name || '-'}
                    </td>
                    <td className={tdCls}>{user.email}</td>
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      <Badge tone={USER_TONE[user.status] || 'neutral'}>{user.status}</Badge>
                    </td>
                    <td className={tdCls}>
                      {user.invited_at ? new Date(user.invited_at).toLocaleString() : '-'}
                    </td>
                    <td className="px-5 py-3.5 whitespace-nowrap text-right text-sm">
                      <div className="flex justify-end gap-1">
                        {user.status === 'active' && (
                          <button
                            onClick={() => suspendMutation.mutate(user)}
                            className="inline-flex items-center text-sm rounded-md px-2 py-1 text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 transition-colors"
                          >
                            Suspend
                          </button>
                        )}
                        {user.status === 'suspended' && (
                          <button
                            onClick={() => resumeMutation.mutate(user)}
                            className="inline-flex items-center text-sm rounded-md px-2 py-1 text-teal-400 hover:text-teal-300 hover:bg-teal-500/10 transition-colors"
                          >
                            Resume
                          </button>
                        )}
                        {user.status !== 'removed' && (
                          <button
                            onClick={() => {
                              if (confirm(`Remove "${user.email}"? Their peers will be removed too.`)) removeMutation.mutate(user)
                            }}
                            className="inline-flex items-center text-sm rounded-md px-2 py-1 text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

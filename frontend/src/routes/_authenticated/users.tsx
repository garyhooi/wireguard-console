import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'

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
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-white">VPN Users</h1>
        <button
          onClick={() => setShowInviteModal(true)}
          className="bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md"
        >
          Invite User
        </button>
      </div>

      {showInviteModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h2 className="text-xl font-bold text-white mb-4">Invite User</h2>
            <form onSubmit={handleInvite} className="space-y-4">
              <div>
                <label htmlFor="inviteEmail" className="block text-sm font-medium text-neutral-400 mb-2">
                  Email
                </label>
                <input
                  id="inviteEmail"
                  type="email"
                  required
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                  placeholder="user@example.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="inviteName" className="block text-sm font-medium text-neutral-400 mb-2">
                  Full Name
                </label>
                <input
                  id="inviteName"
                  type="text"
                  required
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                  placeholder="John Doe"
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                />
              </div>
              <div className="flex space-x-3">
                <button
                  type="button"
                  onClick={() => setShowInviteModal(false)}
                  className="flex-1 bg-neutral-700 hover:bg-neutral-600 text-white font-medium py-2 px-4 rounded-md"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={inviteMutation.isPending || !!inviteLink}
                  className="flex-1 bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md disabled:opacity-50"
                >
                  {inviteMutation.isPending ? 'Creating...' : 'Invite User'}
                </button>
              </div>
            </form>

            {inviteLink && (
              <div className="mt-4 border border-neutral-700 rounded-md p-4">
                {smtp?.configured ? (
                  <p className="text-sm text-neutral-300 mb-2">
                    Invite email queued — the link is also here if you want to share it directly:
                  </p>
                ) : (
                  <p className="text-sm text-yellow-300 mb-2">
                    SMTP is not configured, so the invite email will not be sent. Share this invite
                    link manually:
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={inviteLink}
                    onFocus={(e) => e.target.select()}
                    className="flex-1 bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-sm text-neutral-300 font-mono focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={copyLink}
                    className="bg-neutral-700 hover:bg-neutral-600 text-white text-sm font-medium py-2 px-3 rounded-md"
                  >
                    {copied ? 'Copied ✓' : 'Copy'}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setShowInviteModal(false)
                    setInviteLink('')
                    setInviteEmail('')
                    setInviteName('')
                  }}
                  className="mt-3 w-full bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-neutral-700 overflow-hidden">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setStatusFilter(tab)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                statusFilter === tab
                  ? 'bg-neutral-700 text-white'
                  : 'bg-neutral-900 text-neutral-400 hover:text-white'
              }`}
            >
              {tab === 'all' ? 'All' : tab[0].toUpperCase() + tab.slice(1)}
              <span className="ml-1 text-neutral-500">
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
          className="bg-neutral-800 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-teal-500"
        />
        <span className="text-xs text-neutral-500">{filtered.length} shown</span>
      </div>

      {isLoading ? (
        <div className="text-neutral-400">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-10 text-center text-neutral-500 text-sm">
          No users match this filter.
        </div>
      ) : (
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
          <table className="min-w-full divide-y divide-neutral-800">
            <thead className="bg-neutral-800">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                  Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                  Email
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                  Invited At
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-neutral-400 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-neutral-900 divide-y divide-neutral-800">
              {filtered.map((user) => (
                <tr key={user.id}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-white">
                    {user.full_name || '-'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400">
                    {user.email}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span
                      className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                        user.status === 'active'
                          ? 'bg-green-100 text-green-800'
                          : user.status === 'invited'
                          ? 'bg-blue-100 text-blue-800'
                          : user.status === 'suspended'
                          ? 'bg-yellow-100 text-yellow-800'
                          : 'bg-red-100 text-red-800'
                      }`}
                    >
                      {user.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400">
                    {user.invited_at ? new Date(user.invited_at).toLocaleString() : '-'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                    <div className="flex justify-end gap-2">
                      {user.status === 'active' && (
                        <button onClick={() => suspendMutation.mutate(user)} className="text-amber-400 hover:text-amber-300">
                          Suspend
                        </button>
                      )}
                      {user.status === 'suspended' && (
                        <button onClick={() => resumeMutation.mutate(user)} className="text-teal-400 hover:text-teal-300">
                          Resume
                        </button>
                      )}
                      {user.status !== 'removed' && (
                        <button
                          onClick={() => {
                            if (confirm(`Remove "${user.email}"? Their peers will be removed too.`)) removeMutation.mutate(user)
                          }}
                          className="text-red-400 hover:text-red-300"
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
      )}
    </div>
  )
}

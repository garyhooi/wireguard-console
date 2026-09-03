import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'

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
    onSuccess: () => {
      setShowInviteModal(false)
      setInviteEmail('')
      setInviteName('')
      refetch()
    },
  })

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault()
    inviteMutation.mutate({ email: inviteEmail, full_name: inviteName })
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Users</h1>
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
                  disabled={inviteMutation.isPending}
                  className="flex-1 bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md disabled:opacity-50"
                >
                  {inviteMutation.isPending ? 'Sending...' : 'Send Invite'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-neutral-400">Loading...</div>
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
              </tr>
            </thead>
            <tbody className="bg-neutral-900 divide-y divide-neutral-800">
              {users?.map((user) => (
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

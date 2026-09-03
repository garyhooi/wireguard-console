import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'

interface DomainRule {
  id: string
  scope: 'global' | 'user'
  user_id: string | null
  domain: string
  created_by: string | null
  created_at: string
}

export const Route = createFileRoute('/_authenticated/domain-rules')({
  component: DomainRulesPage,
})

function DomainRulesPage() {
  const [showAddModal, setShowAddModal] = useState(false)
  const [scope, setScope] = useState<'global' | 'user'>('global')
  const [domain, setDomain] = useState('')
  const [userId, setUserId] = useState('')

  const { data: rules, isLoading, refetch } = useQuery<DomainRule[]>({
    queryKey: ['domain-rules'],
    queryFn: async () => {
      const res = await fetch('/api/domain-rules', {
        headers: { Authorization: localStorage.getItem('token')! },
      })
      if (!res.ok) throw new Error('Failed to fetch domain rules')
      return res.json()
    },
  })

  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await fetch('/api/users', {
        headers: { Authorization: localStorage.getItem('token')! },
      })
      if (!res.ok) throw new Error('Failed to fetch users')
      return res.json() as Promise<Array<{ id: string; email: string; full_name: string }>>
    },
    enabled: scope === 'user',
  })

  const addMutation = useMutation({
    mutationFn: async (data: { scope: string; user_id?: string; domain: string }) => {
      const res = await fetch('/api/domain-rules', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: localStorage.getItem('token')!,
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to create domain rule')
      return res.json()
    },
    onSuccess: () => {
      setShowAddModal(false)
      setDomain('')
      setUserId('')
      refetch()
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/domain-rules/${id}`, {
        method: 'DELETE',
        headers: { Authorization: localStorage.getItem('token')! },
      })
      if (!res.ok) throw new Error('Failed to delete domain rule')
      return res.json()
    },
    onSuccess: () => refetch(),
  })

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    const data: { scope: string; user_id?: string; domain: string } = {
      scope,
      domain,
    }
    if (scope === 'user' && userId) {
      data.user_id = userId
    }
    addMutation.mutate(data)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Domain Blocking</h1>
        <button
          onClick={() => setShowAddModal(true)}
          className="bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md"
        >
          Add Rule
        </button>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold text-white mb-2">How It Works</h2>
        <ul className="text-neutral-400 text-sm space-y-1">
          <li>• <strong>Global rules</strong> block domains for all users</li>
          <li>• <strong>User rules</strong> block domains for specific users only</li>
          <li>• Rules use adblock-style syntax: <code className="bg-neutral-800 px-1 rounded">||example.com^</code></li>
          <li>• Subdomains are blocked automatically (e.g., <code className="bg-neutral-800 px-1 rounded">||example.com^</code> blocks example.com and *.example.com)</li>
          <li>• Changes are synced to AdGuard Home immediately</li>
        </ul>
      </div>

      {showAddModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h2 className="text-xl font-bold text-white mb-4">Add Domain Rule</h2>
            <form onSubmit={handleAdd} className="space-y-4">
              <div>
                <label htmlFor="scope" className="block text-sm font-medium text-neutral-400 mb-2">
                  Scope
                </label>
                <select
                  id="scope"
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                  value={scope}
                  onChange={(e) => setScope(e.target.value as 'global' | 'user')}
                >
                  <option value="global">Global (all users)</option>
                  <option value="user">User-specific</option>
                </select>
              </div>

              {scope === 'user' && (
                <div>
                  <label htmlFor="userId" className="block text-sm font-medium text-neutral-400 mb-2">
                    User
                  </label>
                  <select
                    id="userId"
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
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
                <label htmlFor="domain" className="block text-sm font-medium text-neutral-400 mb-2">
                  Domain
                </label>
                <input
                  id="domain"
                  type="text"
                  required
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white font-mono focus:outline-none focus:ring-2 focus:ring-teal-500"
                  placeholder="example.com"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                />
                <p className="text-neutral-500 text-xs mt-1">
                  Enter domain without protocol (e.g., <code className="bg-neutral-800 px-1 rounded">example.com</code>)
                </p>
              </div>

              <div className="flex space-x-3">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 bg-neutral-700 hover:bg-neutral-600 text-white font-medium py-2 px-4 rounded-md"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={addMutation.isPending || !domain}
                  className="flex-1 bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md disabled:opacity-50"
                >
                  {addMutation.isPending ? 'Adding...' : 'Add Rule'}
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
                  Domain
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                  Scope
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                  User
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                  Created
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-neutral-400 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-neutral-900 divide-y divide-neutral-800">
              {rules?.map((rule) => (
                <tr key={rule.id}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-white font-mono">
                    ||{rule.domain}^
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span
                      className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                        rule.scope === 'global'
                          ? 'bg-purple-100 text-purple-800'
                          : 'bg-blue-100 text-blue-800'
                      }`}
                    >
                      {rule.scope}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400">
                    {rule.user_id ? 'User' : '-'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400">
                    {new Date(rule.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button
                      onClick={() => deleteMutation.mutate(rule.id)}
                      className="text-red-400 hover:text-red-300"
                    >
                      Delete
                    </button>
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

import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { IconPlus } from '@tabler/icons-react'
import {
  Badge,
  EmptyState,
  GhostButton,
  Modal,
  PageHeader,
  PrimaryButton,
  Skeleton,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
  inputCls,
  labelCls,
} from '../../lib/ui'

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

  const active = Array.isArray(rules) ? rules : []

  return (
    <div>
      <PageHeader
        title="Domain Blocking"
        description="AdGuard Home rules that block domains for all users or specific users. Changes sync to AdGuard immediately."
        actions={
          <PrimaryButton onClick={() => setShowAddModal(true)}>
            <IconPlus size={16} stroke={1.6} aria-hidden="true" />
            Add Rule
          </PrimaryButton>
        }
      />

      <Modal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        title="Add Domain Rule"
        className="max-w-md"
      >
        <form onSubmit={handleAdd} className="space-y-4">
          <div>
            <label htmlFor="scope" className={labelCls}>
              Scope
            </label>
            <select
              id="scope"
              className={inputCls}
              value={scope}
              onChange={(e) => setScope(e.target.value as 'global' | 'user')}
            >
              <option value="global">Global (all users)</option>
              <option value="user">User-specific</option>
            </select>
          </div>

          {scope === 'user' && (
            <div>
              <label htmlFor="userId" className={labelCls}>
                User
              </label>
              <select
                id="userId"
                className={inputCls}
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
            <label htmlFor="domain" className={labelCls}>
              Domain
            </label>
            <input
              id="domain"
              type="text"
              required
              className={inputCls + ' font-mono'}
              placeholder="example.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
            <p className="text-zinc-500 text-xs mt-1">
              Enter domain without protocol (e.g., <code className="bg-zinc-800 px-1 rounded">example.com</code>)
            </p>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <GhostButton type="button" onClick={() => setShowAddModal(false)}>
              Cancel
            </GhostButton>
            <PrimaryButton type="submit" disabled={addMutation.isPending || !domain}>
              {addMutation.isPending ? 'Adding…' : 'Add Rule'}
            </PrimaryButton>
          </div>
        </form>
      </Modal>

      <div className="border border-zinc-800 rounded-lg bg-zinc-900/50 p-6 mb-6">
        <h2 className="text-sm font-medium text-zinc-200 mb-3">How It Works</h2>
        <ul className="text-zinc-400 text-sm space-y-1.5 leading-relaxed">
          <li>• <strong className="text-zinc-200">Global rules</strong> block domains for all users</li>
          <li>• <strong className="text-zinc-200">User rules</strong> block domains for specific users only</li>
          <li>• Rules use adblock-style syntax: <code className="bg-zinc-800 px-1 rounded">||example.com^</code></li>
          <li>• Subdomains are blocked automatically (e.g., <code className="bg-zinc-800 px-1 rounded">||example.com^</code> blocks example.com and *.example.com)</li>
          <li>• Changes are synced to AdGuard Home immediately</li>
        </ul>
      </div>

      <div className={tableWrapCls}>
        {isLoading ? (
          <div className="p-5 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : active.length === 0 ? (
          <EmptyState
            title="No domain rules yet"
            hint="Add a rule to block domains via AdGuard Home for all users or a specific user."
            action={<PrimaryButton onClick={() => setShowAddModal(true)}><IconPlus size={16} stroke={1.6} aria-hidden="true" />Add Rule</PrimaryButton>}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 bg-zinc-800/40">
                  <th className={thCls}>Domain</th>
                  <th className={thCls}>Scope</th>
                  <th className={thCls}>User</th>
                  <th className={thCls}>Created</th>
                  <th className={thCls + ' text-right'}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {active.map((rule) => (
                  <tr key={rule.id} className="hover:bg-zinc-800/30 transition-colors">
                    <td className={tdCls + ' font-mono'}>{`||${rule.domain}^`}</td>
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      <Badge tone={rule.scope === 'global' ? 'accent' : 'info'}>{rule.scope}</Badge>
                    </td>
                    <td className={tdCls}>{rule.user_id ? 'User' : '—'}</td>
                    <td className={tdCls}>
                      {new Date(rule.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-3.5 whitespace-nowrap text-right text-sm font-medium">
                      <button
                        onClick={() => deleteMutation.mutate(rule.id)}
                        className="inline-flex items-center text-sm rounded-md px-2 py-1 text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
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
    </div>
  )
}

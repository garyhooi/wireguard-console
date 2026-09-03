import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

interface Peer {
  id: string
  user_id: string
  server_id: string
  name: string
  public_key: string
  allowed_ip: string
  status: string
  last_handshake_at: string | null
  created_at: string
}

interface Server {
  id: string
  name: string
}

interface User {
  id: string
  email: string
  full_name: string | null
}

export const Route = createFileRoute('/_authenticated/peers')({
  component: PeersPage,
})

function PeersPage() {
  const queryClient = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ name: '', server_id: '', user_id: '' })

  const { data: peers, isLoading } = useQuery<Peer[]>({
    queryKey: ['peers'],
    queryFn: async () => {
      const res = await fetch('/api/peers', {
        headers: { Authorization: localStorage.getItem('token')! },
      })
      if (!res.ok) throw new Error('Failed to fetch peers')
      return res.json()
    },
    refetchInterval: 15000,
  })

  const { data: servers } = useQuery<Server[]>({
    queryKey: ['servers'],
    queryFn: async () => {
      const res = await fetch('/api/servers', {
        headers: { Authorization: localStorage.getItem('token')! },
      })
      if (!res.ok) throw new Error('Failed to fetch servers')
      return res.json()
    },
  })

  const { data: users } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await fetch('/api/users', {
        headers: { Authorization: localStorage.getItem('token')! },
      })
      if (!res.ok) throw new Error('Failed to fetch users')
      return res.json()
    },
  })

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/peers', {
        method: 'POST',
        headers: {
          Authorization: localStorage.getItem('token')!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(form),
      })
      if (!res.ok) throw new Error('Failed to create peer')
      return res.json()
    },
    onSuccess: (data) => {
      setShowAdd(false)
      setError('')
      setForm({ name: '', server_id: '', user_id: '' })
      queryClient.invalidateQueries({ queryKey: ['peers'] })
      if (data?.public_key || data?.allowed_ip) {
        setError(
          `Created — peer public key ${(data.public_key || '').substring(0, 12)}…, IP ${data.allowed_ip || ''}`
        )
      }
    },
    onError: (e: Error) => setError(e.message),
  })

  if (isLoading) {
    return <div className="text-neutral-400">Loading...</div>
  }

  const noServers = !servers || servers.length === 0
  const noUsers = !users || users.length === 0

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Peers</h1>
        <button
          onClick={() => setShowAdd(true)}
          className="bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md"
        >
          Add Peer
        </button>
      </div>

      {showAdd && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h2 className="text-xl font-bold text-white mb-1">Add Peer</h2>
            <p className="text-sm text-neutral-400 mb-4">
              A peer is one device (laptop, phone…) for a user on a server. Keys and the tunnel IP
              are generated automatically.
            </p>
            {(noServers || noUsers) && (
              <div className="bg-yellow-900/40 border border-yellow-700 text-yellow-200 text-sm rounded-md p-3 mb-4">
                {noServers && <p>Create a server first (Servers → Add Server).</p>}
                {noUsers && <p>Create a user first (Users → Invite User).</p>}
              </div>
            )}
            {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
            <form
              onSubmit={(e) => {
                e.preventDefault()
                createMutation.mutate()
              }}
              className="space-y-4"
            >
              <div>
                <label htmlFor="pName" className="block text-sm font-medium text-neutral-400 mb-2">
                  Device name
                </label>
                <input
                  id="pName"
                  required
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Gary's MacBook"
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <div>
                <label htmlFor="pServer" className="block text-sm font-medium text-neutral-400 mb-2">
                  Server
                </label>
                <select
                  id="pServer"
                  required
                  value={form.server_id}
                  onChange={(e) => setForm((f) => ({ ...f, server_id: e.target.value }))}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                >
                  <option value="" disabled>
                    {noServers ? 'No servers — create one first' : 'Select a server…'}
                  </option>
                  {servers?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="pUser" className="block text-sm font-medium text-neutral-400 mb-2">
                  User
                </label>
                <select
                  id="pUser"
                  required
                  value={form.user_id}
                  onChange={(e) => setForm((f) => ({ ...f, user_id: e.target.value }))}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                >
                  <option value="" disabled>
                    {noUsers ? 'No users — invite one first' : 'Select a user…'}
                  </option>
                  {users?.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.full_name || u.email}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex space-x-3">
                <button
                  type="submit"
                  disabled={createMutation.isPending || noServers || noUsers}
                  className="bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md disabled:opacity-50"
                >
                  {createMutation.isPending ? 'Creating...' : 'Create Peer'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  className="bg-neutral-700 hover:bg-neutral-600 text-white font-medium py-2 px-4 rounded-md"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-neutral-800">
          <thead className="bg-neutral-800">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Public Key
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Allowed IP
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Last Handshake
              </th>
            </tr>
          </thead>
          <tbody className="bg-neutral-900 divide-y divide-neutral-800">
            {peers?.map((peer) => (
              <tr key={peer.id}>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-white">{peer.name}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400 font-mono">
                  {peer.public_key.substring(0, 16)}...
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400 font-mono">
                  {peer.allowed_ip}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span
                    className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                      peer.status === 'active'
                        ? 'bg-green-100 text-green-800'
                        : peer.status === 'suspended'
                        ? 'bg-yellow-100 text-yellow-800'
                        : 'bg-red-100 text-red-800'
                    }`}
                  >
                    {peer.status}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400">
                  {peer.last_handshake_at
                    ? new Date(peer.last_handshake_at).toLocaleString()
                    : 'Never'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
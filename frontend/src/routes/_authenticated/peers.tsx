import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

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

export const Route = createFileRoute('/_authenticated/peers')({
  component: PeersPage,
})

function PeersPage() {
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

  if (isLoading) {
    return <div className="text-neutral-400">Loading...</div>
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">Peers</h1>

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
                <td className="px-6 py-4 whitespace-nowrap text-sm text-white">
                  {peer.name}
                </td>
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

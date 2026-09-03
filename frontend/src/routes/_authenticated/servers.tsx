import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

interface Server {
  id: string
  name: string
  public_endpoint: string
  listen_port: number
  interface_name: string
  server_public_key: string
  network_cidr: string
  status: string
  created_at: string
}

export const Route = createFileRoute('/_authenticated/servers')({
  component: ServersPage,
})

function ServersPage() {
  const { data: servers, isLoading } = useQuery<Server[]>({
    queryKey: ['servers'],
    queryFn: async () => {
      const res = await fetch('/api/servers', {
        headers: { Authorization: localStorage.getItem('token')! },
      })
      if (!res.ok) throw new Error('Failed to fetch servers')
      return res.json()
    },
  })

  if (isLoading) {
    return <div className="text-neutral-400">Loading...</div>
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">Servers</h1>

      <div className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-neutral-800">
          <thead className="bg-neutral-800">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Endpoint
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Interface
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Network
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Status
              </th>
            </tr>
          </thead>
          <tbody className="bg-neutral-900 divide-y divide-neutral-800">
            {servers?.map((server) => (
              <tr key={server.id}>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-white">
                  {server.name}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400 font-mono">
                  {server.public_endpoint}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400 font-mono">
                  {server.interface_name}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-400 font-mono">
                  {server.network_cidr}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span
                    className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                      server.status === 'active'
                        ? 'bg-green-100 text-green-800'
                        : 'bg-red-100 text-red-800'
                    }`}
                  >
                    {server.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

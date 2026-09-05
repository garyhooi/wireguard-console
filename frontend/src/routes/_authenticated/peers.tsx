import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import QRCode from 'qrcode'
import { IconCopy, IconDownload, IconMailForward, IconPlus, IconQrcode } from '@tabler/icons-react'
import {
  ActionLink,
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

interface Peer {
  id: string
  user_id: string
  server_id: string
  name: string
  public_key: string | null
  allowed_ip: string
  status: string
  last_handshake_at: string | null
  created_at: string
  user_email: string
  user_full_name: string
}

interface Server {
  id: string
  name: string
}

interface User {
  id: string
  email: string
  full_name: string | null
  status: string
}

export const Route = createFileRoute('/_authenticated/peers')({
  component: PeersPage,
})

const auth = { Authorization: localStorage.getItem('token')! }

function PeersPage() {
  const queryClient = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState<Peer | null>(null)
  const [error, setError] = useState('')
  const [qr, setQr] = useState<{ name: string; dataUrl: string } | null>(null)
  const [form, setForm] = useState({ name: '', server_id: '', user_id: '', send_email: false })
  const [createdLink, setCreatedLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [resent, setResent] = useState<{ peerName: string; link: string } | null>(null)
  const [resentCopied, setResentCopied] = useState(false)
  const [resendingId, setResendingId] = useState('')

  const { data: smtp } = useQuery<{ configured: boolean }>({
    queryKey: ['smtp-config'],
    queryFn: async () => {
      const res = await fetch('/api/config/smtp', { headers: auth })
      if (!res.ok) throw new Error('Failed to fetch SMTP config')
      return res.json()
    },
  })

  const { data: peers, isLoading } = useQuery<Peer[]>({
    queryKey: ['peers'],
    queryFn: async () => {
      const res = await fetch('/api/peers', { headers: auth })
      if (!res.ok) throw new Error('Failed to fetch peers')
      return res.json()
    },
    refetchInterval: 15000,
  })

  const { data: servers } = useQuery<Server[]>({
    queryKey: ['servers'],
    queryFn: async () => {
      const res = await fetch('/api/servers', { headers: auth })
      if (!res.ok) throw new Error('Failed to fetch servers')
      return res.json()
    },
  })

  const { data: users } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await fetch('/api/users', { headers: auth })
      if (!res.ok) throw new Error('Failed to fetch users')
      return res.json()
    },
  })

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/peers', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) throw new Error('Failed to create peer')
      return res.json()
    },
    onSuccess: (data) => {
      if (data?.config_link) {
        // Email (if SMTP is on) contains the same link; show it in the modal
        // so the admin can also copy/share it manually.
        setCreatedLink(data.config_link)
        setCopied(false)
        setError('')
        setForm({ name: '', server_id: '', user_id: '', send_email: false })
        queryClient.invalidateQueries({ queryKey: ['peers'] })
        return
      }
      setShowAdd(false)
      setError('')
      setForm({ name: '', server_id: '', user_id: '', send_email: false })
      queryClient.invalidateQueries({ queryKey: ['peers'] })
      if (data?.allowed_ip) setError(`Created — peer IP ${data.allowed_ip}`)
    },
    onError: (e: Error) => setError(e.message),
  })

  const copyLink = async () => {
    if (!createdLink) return
    try {
      await navigator.clipboard.writeText(createdLink)
      setCopied(true)
    } catch {
      const el = document.createElement('textarea')
      el.value = createdLink
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setCopied(true)
    }
  }

  const openAdd = () => {
    setEditing(null)
    setCreatedLink('')
    setForm({ name: '', server_id: '', user_id: '', send_email: false })
    setShowAdd(true)
  }

  const closeAdd = () => {
    setShowAdd(false)
    setEditing(null)
    setCreatedLink('')
  }

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!editing) return
      const res = await fetch(`/api/peers/${editing.id}`, {
        method: 'PATCH',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name }),
      })
      if (!res.ok) throw new Error('Failed to update peer')
      return res.json()
    },
    onSuccess: () => {
      setEditing(null)
      setError('')
      queryClient.invalidateQueries({ queryKey: ['peers'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const removeMutation = useMutation({
    mutationFn: async (peer: Peer) => {
      const res = await fetch(`/api/peers/${peer.id}`, {
        method: 'DELETE',
        headers: auth,
      })
      if (!res.ok) throw new Error('Failed to remove peer')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['peers'] }),
    onError: (e: Error) => setError(e.message),
  })

  const resendMutation = useMutation({
    mutationFn: async (peer: Peer) => {
      setResendingId(peer.id)
      const res = await fetch(`/api/peers/${peer.id}/resend-config-email`, {
        method: 'POST',
        headers: auth,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(
          (err as { error?: string }).error || 'Failed to resend the config link email',
        )
      }
      return res.json()
    },
    onSuccess: (data, peer) => {
      setResent({ peerName: peer.name, link: data.config_link || '' })
      setResentCopied(false)
      setError('')
    },
    onError: (e: Error) => setError(e.message),
    onSettled: () => setResendingId(''),
  })

  const copyResentLink = async () => {
    if (!resent?.link) return
    try {
      await navigator.clipboard.writeText(resent.link)
      setResentCopied(true)
    } catch {
      const el = document.createElement('textarea')
      el.value = resent.link
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setResentCopied(true)
    }
  }

  const fetchConfigText = async (peer: Peer): Promise<string | null> => {
    const res = await fetch(`/api/peers/${peer.id}/config`, { headers: auth })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      setError(err.error || 'Failed to get config')
      return null
    }
    return res.text()
  }

  const downloadConfig = async (peer: Peer) => {
    const text = await fetchConfigText(peer)
    if (!text) return
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${peer.name}.conf`
    a.click()
    URL.revokeObjectURL(url)
  }

  const showQR = async (peer: Peer) => {
    const text = await fetchConfigText(peer)
    if (!text) return
    const dataUrl = await QRCode.toDataURL(text, { width: 320, margin: 1 })
    setQr({ name: peer.name, dataUrl })
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-56 wgc-skeleton rounded-md" />
        <div className="h-64 w-full wgc-skeleton rounded-lg" />
      </div>
    )
  }

  // Drop malformed/partial entries (e.g. a row captured mid-refetch) so a
  // missing id or key can never crash the table render.
  const activePeers = (peers || []).filter((p) => p && p.id && p.status !== 'removed')
  // Removed users are stripped from the Add Peer dropdown — a peer can only
  // be attached to an active/invited/suspended user, never a removed one.
  const addableUsers = (users || []).filter((u) => u.status !== 'removed')
  const noServers = !servers || servers.length === 0
  const noUsers = !users || addableUsers.length === 0

  return (
    <div>
      <PageHeader
        title="Peers"
        description="One peer is one device (laptop, phone…) for a user on a server. Keys and the tunnel IP are generated automatically."
        actions={
          <PrimaryButton onClick={openAdd}>
            <IconPlus size={16} stroke={1.6} aria-hidden="true" />
            Add Peer
          </PrimaryButton>
        }
      />

      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

      {/* Add / edit modal */}
      <Modal
        open={showAdd || editing !== null || createdLink !== ''}
        onClose={closeAdd}
        title={editing ? 'Edit Peer' : 'Add Peer'}
        description={
          editing
            ? 'Rename the device.'
            : 'A peer is one device for a user on a server. Keys and the tunnel IP are generated automatically.'
        }
      >
        {createdLink ? (
          <div>
            {smtp?.configured ? (
              <p className="text-sm text-zinc-300 mb-2">
                Peer created — the config link was emailed to the user. Share it directly too if
                you like:
              </p>
            ) : (
              <p className="text-sm text-amber-300 mb-2">
                Peer created — SMTP is not configured, so no email was sent. Share this config
                link manually so the user can download the .conf or scan the QR:
              </p>
            )}
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={createdLink}
                onFocus={(e) => e.target.select()}
                className={`${inputCls} font-mono text-sm`}
              />
              <GhostButton type="button" onClick={copyLink} className="shrink-0">
                <IconCopy size={15} stroke={1.6} aria-hidden="true" />
                {copied ? 'Copied' : 'Copy'}
              </GhostButton>
            </div>
            <p className="text-xs text-zinc-500 mt-2">
              The link expires automatically (72h) and only serves this peer's config.
            </p>
            <div className="mt-4 flex justify-end">
              <PrimaryButton type="button" onClick={closeAdd}>
                Done
              </PrimaryButton>
            </div>
          </div>
        ) : (
        <div>
        {(noServers || noUsers) && !editing && (
          <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm rounded-md p-3 mb-4">
            {noServers && <p>Create a server first (Servers → Add Server).</p>}
            {noUsers && <p>Create a user first (Users → Invite User).</p>}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            editing ? updateMutation.mutate() : createMutation.mutate()
          }}
          className="space-y-4"
        >
          <div>
            <label htmlFor="pName" className={labelCls}>
              Device name
            </label>
            <input
              id="pName"
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Gary's MacBook"
              className={inputCls}
            />
          </div>
          {!editing && (
            <>
              <div>
                <label htmlFor="pServer" className={labelCls}>
                  Server
                </label>
                <select
                  id="pServer"
                  required
                  value={form.server_id}
                  onChange={(e) => setForm((f) => ({ ...f, server_id: e.target.value }))}
                  className={inputCls}
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
                <label htmlFor="pUser" className={labelCls}>
                  User
                </label>
                <select
                  id="pUser"
                  required
                  value={form.user_id}
                  onChange={(e) => setForm((f) => ({ ...f, user_id: e.target.value }))}
                  className={inputCls}
                >
                  <option value="" disabled>
                    {noUsers ? 'No users — invite one first' : 'Select a user…'}
                  </option>
                  {addableUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.full_name || u.email}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
          {!editing && (
            <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-zinc-700 bg-zinc-800 accent-teal-500"
                checked={form.send_email}
                onChange={(e) => setForm((f) => ({ ...f, send_email: e.target.checked }))}
              />
              Email the user a secure link to download / scan their config (sent when SMTP is configured)
            </label>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <GhostButton type="button" onClick={closeAdd}>
              Cancel
            </GhostButton>
            <PrimaryButton
              type="submit"
              disabled={
                createMutation.isPending || updateMutation.isPending || (!editing && (noServers || noUsers))
              }
            >
              {createMutation.isPending || updateMutation.isPending ? 'Saving…' : editing ? 'Save' : 'Create Peer'}
            </PrimaryButton>
          </div>
        </form>
        </div>
        )}
      </Modal>

      {/* QR modal */}
      <Modal
        open={qr !== null}
        onClose={() => setQr(null)}
        title={qr ? qr.name : undefined}
        className="max-w-md"
      >
        <div className="text-center">
          <img
            src={qr?.dataUrl}
            alt={`${qr?.name ?? 'Peer'} config QR`}
            className="mx-auto rounded-md bg-white p-2"
          />
          <p className="text-sm text-zinc-400 mt-4 mb-4">
            Scan in the WireGuard app (import from QR code)
          </p>
          <GhostButton onClick={() => setQr(null)}>Close</GhostButton>
        </div>
      </Modal>

      {/* Config-link email re-sent — the fresh link is offered for manual
          sharing too, in case SMTP delivery fails again. */}
      <Modal
        open={resent !== null}
        onClose={() => setResent(null)}
        title="Config link email re-sent"
        className="max-w-md"
      >
        <div className="space-y-3">
          <p className="text-sm text-zinc-300">
            A fresh config link for <span className="text-zinc-100">{resent?.peerName}</span> was
            emailed to its user.
            {smtp?.configured ? (
              <span className="text-zinc-400"> Share it directly too if you like:</span>
            ) : (
              <span className="text-amber-300">
                {' '}
                SMTP is not configured, so no email is actually sent — share this link manually:
              </span>
            )}
          </p>
          {resent?.link && (
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={resent.link}
                onFocus={(e) => e.target.select()}
                className={`${inputCls} font-mono text-sm`}
              />
              <GhostButton type="button" onClick={copyResentLink} className="shrink-0">
                <IconCopy size={15} stroke={1.6} aria-hidden="true" />
                {resentCopied ? 'Copied' : 'Copy'}
              </GhostButton>
            </div>
          )}
          <p className="text-xs text-zinc-500">
            The link expires automatically (72h) and only serves this peer's config.
          </p>
          <div className="flex justify-end pt-1">
            <PrimaryButton type="button" onClick={() => setResent(null)}>
              Done
            </PrimaryButton>
          </div>
        </div>
      </Modal>

      {activePeers.length === 0 ? (
        <EmptyState
          title="No peers yet"
          hint="Create a server, invite a user, then add a peer — the tunnel config is generated automatically."
          action={
            <PrimaryButton onClick={openAdd}>
              <IconPlus size={16} stroke={1.6} aria-hidden="true" />
              Add peer
            </PrimaryButton>
          }
        />
      ) : (
        <div className={tableWrapCls}>
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 bg-zinc-800/40">
                  <th className={thCls}>Name</th>
                  <th className={thCls}>User</th>
                  <th className={thCls}>Public Key</th>
                  <th className={thCls}>Allowed IP</th>
                  <th className={thCls}>Status</th>
                  <th className={thCls}>Last Handshake</th>
                  <th className={thCls + ' text-right'}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {activePeers.map((peer) => (
                  <tr key={peer.id} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="px-5 py-3.5 whitespace-nowrap text-sm text-zinc-200">{peer.name}</td>
                    <td className={tdCls}>
                      {peer.user_full_name || peer.user_email || '—'}
                    </td>
                    <td className={tdCls + ' font-mono'}>
                      {peer.public_key ? `${peer.public_key.substring(0, 16)}...` : '—'}
                    </td>
                    <td className={tdCls + ' font-mono'}>{peer.allowed_ip}</td>
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      <Badge tone={peer.status === 'active' ? 'good' : peer.status === 'suspended' ? 'warn' : 'bad'}>
                        {peer.status}
                      </Badge>
                    </td>
                    <td className={tdCls + ' font-mono tabular-nums'}>
                      {peer.last_handshake_at ? new Date(peer.last_handshake_at).toLocaleString() : 'Never'}
                    </td>
                    <td className="px-5 py-3.5 whitespace-nowrap text-right text-sm">
                      <div className="flex justify-end gap-1">
                        <ActionLink
                          onClick={() => {
                            setCreatedLink('')
                            setEditing(peer)
                            setForm({ name: peer.name, server_id: peer.server_id, user_id: peer.user_id, send_email: false })
                            setShowAdd(false)
                          }}
                        >
                          Edit
                        </ActionLink>
                        <ActionLink
                          onClick={() => downloadConfig(peer)}
                        >
                          <IconDownload size={14} stroke={1.6} aria-hidden="true" />
                          Config
                        </ActionLink>
                        <ActionLink onClick={() => showQR(peer)}>
                          <IconQrcode size={14} stroke={1.6} aria-hidden="true" />
                          QR
                        </ActionLink>
                        <ActionLink
                          onClick={() => {
                            if (resendingId !== peer.id) resendMutation.mutate(peer)
                          }}
                        >
                          <IconMailForward size={14} stroke={1.6} aria-hidden="true" />
                          {resendingId === peer.id ? 'Emailing…' : 'Email link'}
                        </ActionLink>
                        <ActionLink
                          tone="danger"
                          onClick={() => {
                            if (confirm(`Remove peer "${peer.name}"?`)) removeMutation.mutate(peer)
                          }}
                        >
                          Remove
                        </ActionLink>
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

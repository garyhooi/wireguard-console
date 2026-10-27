import { createFileRoute } from '@tanstack/react-router'
import { apiFetch, apiJson } from '../../lib/api'
import { userLabel } from '../../lib/userLabel'
import { fmtDateTime } from '../../lib/timezone'
import { configFileName } from '../../lib/filename'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
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
  /** Joined department name (newer backends); absorbs into the user label. */
  user_department_name?: string
  server_name: string
}

interface Server {
  id: string
  name: string
}

interface User {
  id: string
  email: string
  full_name: string | null
  department_name?: string
  status: string
}

/** Stable idempotency key for one Add-Peer modal session. */
function generateRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // crypto.randomUUID can throw (insecure context / very old browsers) —
    // fall through to the Math.random fallback.
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const NETWORK_ERROR_RE = /load failed|failed to fetch/i

/**
 * True when a create never got an HTTP response (offline, connection reset,
 * browser/proxy abort). Such failures are TypeErrors or the browser's
 * "Load failed" / "Failed to fetch" message — and they say nothing about
 * whether the server committed the write.
 */
function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return NETWORK_ERROR_RE.test(message)
}

const NETWORK_ERROR_HINT =
  'The create request got no response — the peer may already have been created. ' +
  'The peers list has been refreshed, and retrying is safe: the same request ID is sent ' +
  'again, so a duplicate peer cannot be created.'

function createErrorMessage(e: unknown): string {
  if (isNetworkError(e)) return NETWORK_ERROR_HINT
  return e instanceof Error && e.message ? e.message : 'Failed to create peer'
}

export const Route = createFileRoute('/_authenticated/peers')({
  component: PeersPage,
})


export function PeersPage() {
  const queryClient = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState<Peer | null>(null)
  const [error, setError] = useState('')
  // Positive outcome line ("Created — peer IP …"), deliberately separate from
  // `error` so a successful create is never painted as a failure.
  const [notice, setNotice] = useState('')
  // Idempotency key for the current Add-Peer session: reused by every retry
  // of the same modal so the server replays the original peer instead of
  // creating a duplicate.
  const requestIdRef = useRef('')
  const [qr, setQr] = useState<{ name: string; dataUrl: string } | null>(null)
  const [form, setForm] = useState({ name: '', server_id: '', user_id: '', send_email: false })
  const [createdLink, setCreatedLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [resent, setResent] = useState<{ peerName: string; link: string } | null>(null)
  const [resentCopied, setResentCopied] = useState(false)
  const [resendingId, setResendingId] = useState('')
  // Peer awaiting confirmation before the config-link email is actually
  // sent — prevents an accidental click on "Email link" from emailing
  // the user immediately.
  const [confirmResendPeer, setConfirmResendPeer] = useState<Peer | null>(null)

  const { data: smtp } = useQuery<{ configured: boolean }>({
    queryKey: ['smtp-config'],
    queryFn: async () => {
      return apiJson<{ configured: boolean }>('/api/config/smtp')
    },
  })

  const { data: peers, isLoading } = useQuery<Peer[]>({
    queryKey: ['peers'],
    queryFn: async () => {
      return apiJson<Peer[]>('/api/peers')
    },
    refetchInterval: 15000,
  })

  const { data: servers } = useQuery<Server[]>({
    queryKey: ['servers'],
    queryFn: async () => {
      return apiJson<Server[]>('/api/servers')
    },
  })

  const { data: users } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: async () => {
      return apiJson<User[]>('/api/users')
    },
  })

  const createMutation = useMutation({
    mutationFn: async () => {
      // One id per modal session; a retry replays the same request instead of
      // creating a second peer.
      if (!requestIdRef.current) requestIdRef.current = generateRequestId()
      return apiJson<{
        status?: string
        public_key?: string
        config_link?: string
        allowed_ip?: string
      }>('/api/peers', { method: 'POST', body: { ...form, request_id: requestIdRef.current } })
    },
    onSuccess: (data) => {
      // The peer is committed (or was already committed by an earlier attempt
      // replaying this id) — the next modal session gets a fresh id.
      requestIdRef.current = generateRequestId()
      setError('')
      if (data?.config_link) {
        // Email (if SMTP is on) contains the same link; show it in the modal
        // so the admin can also copy/share it manually.
        setCreatedLink(data.config_link)
        setCopied(false)
        setNotice('')
        setForm({ name: '', server_id: '', user_id: '', send_email: false })
        queryClient.invalidateQueries({ queryKey: ['peers'] })
        return
      }
      setShowAdd(false)
      setForm({ name: '', server_id: '', user_id: '', send_email: false })
      queryClient.invalidateQueries({ queryKey: ['peers'] })
      if (data?.allowed_ip) {
        // A replayed create (status "exists") already landed on an earlier
        // attempt; say so without implying a second peer was made.
        setNotice(
          data.status === 'exists'
            ? `Created — peer IP ${data.allowed_ip} (no duplicate was created)`
            : `Created — peer IP ${data.allowed_ip}`,
        )
      } else {
        setNotice(
          data?.status === 'exists' ? 'Created — no duplicate was created' : 'Peer created.',
        )
      }
    },
    onError: () => {
      // The response never arrived, but the write may still have landed:
      // refresh now so a committed peer appears even before the admin retries.
      // The message itself is rendered from the mutation error inside the
      // modal (see createErrorMessage): network failures become a truthful
      // "may already have been created" hint instead of a bare "Load failed".
      setNotice('')
      queryClient.invalidateQueries({ queryKey: ['peers'] })
    },
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
    createMutation.reset()
    // Fresh idempotency key per Add-Peer session: retries within the modal
    // reuse it; a reopened modal never does.
    requestIdRef.current = generateRequestId()
    setEditing(null)
    setCreatedLink('')
    setNotice('')
    setForm({ name: '', server_id: '', user_id: '', send_email: false })
    setShowAdd(true)
  }

  const closeAdd = () => {
    createMutation.reset()
    requestIdRef.current = generateRequestId()
    setShowAdd(false)
    setEditing(null)
    setCreatedLink('')
  }

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!editing) return
      return apiJson<{ allowed_ip?: string }>(`/api/peers/${editing.id}`, {
        method: 'PATCH',
        body: { name: form.name },
      })
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
      await apiJson(`/api/peers/${peer.id}`, { method: 'DELETE' })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['peers'] }),
    onError: (e: Error) => setError(e.message),
  })

  const resendMutation = useMutation({
    mutationFn: async (peer: Peer) => {
      setResendingId(peer.id)
      return apiJson<{ config_link?: string }>(`/api/peers/${peer.id}/resend-config-email`, { method: 'POST' })
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
    const res = await apiFetch(`/api/peers/${peer.id}/config`)
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
    a.download = configFileName(peer.name)
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
      {notice && (
        <p role="status" className="text-teal-400 text-sm mb-3">
          {notice}
        </p>
      )}

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
              The link expires automatically and only serves this peer's config.
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
                      {userLabel(u.full_name, u.email, u.department_name)}
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
          {!editing && createMutation.isError && (
            <p
              role="alert"
              className={`text-sm ${
                isNetworkError(createMutation.error) ? 'text-amber-300' : 'text-red-400'
              }`}
            >
              {createErrorMessage(createMutation.error)}
            </p>
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

      {/* Confirm before emailing a config link — the row action only opens
          this dialog, so an accidental click never sends an email. */}
      <Modal
        open={confirmResendPeer !== null}
        onClose={() => setConfirmResendPeer(null)}
        title="Email config link?"
        className="max-w-md"
      >
        <div className="space-y-4">
          <p className="text-sm text-zinc-300">
            This sends a fresh config link for{' '}
            <span className="text-zinc-100">{confirmResendPeer?.name}</span> to{' '}
            <span className="text-zinc-100">
              {confirmResendPeer?.user_full_name || confirmResendPeer?.user_email
                ? userLabel(
                    confirmResendPeer?.user_full_name,
                    confirmResendPeer?.user_email,
                    confirmResendPeer?.user_department_name,
                  )
                : 'its user'}
            </span>
            .
          </p>
          {!smtp?.configured && (
            <p className="text-sm text-amber-300">
              SMTP is not configured, so no email will actually be sent — you'll only get a link to
              share manually.
            </p>
          )}
          <p className="text-xs text-zinc-500">
            A new link is minted (previous links stay valid). The email contains the link only —
            never the config or private key.
          </p>
          <div className="flex justify-end gap-3 pt-1">
            <GhostButton type="button" onClick={() => setConfirmResendPeer(null)}>
              Cancel
            </GhostButton>
            <PrimaryButton
              type="button"
              disabled={resendingId === confirmResendPeer?.id}
              onClick={() => {
                if (confirmResendPeer) {
                  setConfirmResendPeer(null)
                  resendMutation.mutate(confirmResendPeer)
                }
              }}
            >
              {resendingId === confirmResendPeer?.id ? 'Sending…' : 'Resend email'}
            </PrimaryButton>
          </div>
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
            The link expires automatically and only serves this peer's config.
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
                  <th className={thCls}>Server</th>
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
                    <td className={tdCls}>{peer.server_name || '—'}</td>
                    <td className={tdCls}>
                      {userLabel(peer.user_full_name, peer.user_email, peer.user_department_name)}
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
                      {peer.last_handshake_at ? fmtDateTime(peer.last_handshake_at) : 'Never'}
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
                            if (resendingId !== peer.id) setConfirmResendPeer(peer)
                          }}
                        >
                          <IconMailForward size={14} stroke={1.6} aria-hidden="true" />
                          Email link
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

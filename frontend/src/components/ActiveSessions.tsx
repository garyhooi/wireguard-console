import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  IconClock,
  IconDeviceDesktop,
  IconDeviceImac,
  IconDeviceLaptop,
  IconDeviceMobile,
  IconLogout,
  IconWorld,
} from '@tabler/icons-react'
import { apiJson } from '../lib/api'
import { Badge, EmptyState, GhostButton, Panel } from '../lib/ui'

/**
 * ActiveSessions — Profile → Active Sessions.
 *
 * Lists every live session for the signed-in admin (the current one marked
 * "this device"), with per-session revoke and a "sign out everywhere else"
 * action. Sessions idle longer than SESSION_IDLE_MINUTES are rejected by
 * the server; this panel is where an admin notices a lost/compromised
 * device and kills it without waiting for the idle or absolute timeout.
 */

interface Session {
  id: string
  ip_address: string | null
  user_agent: string
  created_at: string
  last_seen_at: string | null
  expires_at: string
  is_current: boolean
  is_pending_2fa: boolean
}

interface SessionsResponse {
  sessions: Session[]
}

/** A short human label for a user-agent, e.g. "Chrome on macOS". */
function deviceLabel(ua: string): string {
  if (!ua) return 'Unknown device'
  const lower = ua.toLowerCase()
  let browser = 'Browser'
  if (lower.includes('edg/')) browser = 'Edge'
  else if (lower.includes('opr/') || lower.includes('opera')) browser = 'Opera'
  else if (lower.includes('firefox/')) browser = 'Firefox'
  else if (lower.includes('chrome/')) browser = 'Chrome'
  else if (lower.includes('safari/')) browser = 'Safari'

  let os = 'Unknown OS'
  if (lower.includes('windows')) os = 'Windows'
  else if (lower.includes('iphone') || lower.includes('ipad')) os = 'iOS'
  else if (lower.includes('android')) os = 'Android'
  else if (lower.includes('mac os')) os = 'macOS'
  else if (lower.includes('linux')) os = 'Linux'

  return `${browser} on ${os}`
}

function deviceIcon(ua: string) {
  const lower = ua.toLowerCase()
  if (lower.includes('iphone') || lower.includes('android') || lower.includes('mobile'))
    return IconDeviceMobile
  if (lower.includes('ipad') || lower.includes('tablet')) return IconDeviceLaptop
  if (lower.includes('mac os') || lower.includes('windows')) return IconDeviceDesktop
  return IconDeviceImac
}

/** "just now", "3m ago", "2h ago", "3d ago". */
function ago(iso: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(diff) || diff < 0) return 'now'
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function expiresIn(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now()
  const h = Math.ceil(diff / 3_600_000)
  if (h <= 0) return 'expired'
  if (h < 48) return `in ${h}h`
  return `in ${Math.floor(h / 24)}d`
}

export function ActiveSessions() {
  const queryClient = useQueryClient()
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const { data, isLoading } = useQuery<SessionsResponse>({
    queryKey: ['my-sessions'],
    queryFn: async () => apiJson<SessionsResponse>('/api/admins/me/sessions'),
    refetchInterval: 60000,
  })
  const sessions = data?.sessions ?? []

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['my-sessions'] })
  }

  const revokeMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiJson(`/api/admins/me/sessions/${id}`, { method: 'DELETE' })
    },
    onSuccess: () => {
      setNotice('Session revoked.')
      setError('')
      invalidate()
    },
    onError: (e: Error) => {
      setError(e.message)
      setNotice('')
    },
  })

  const revokeOthersMutation = useMutation({
    mutationFn: async () => {
      return apiJson<{ revoked: number }>('/api/admins/me/sessions/revoke-others', {
        method: 'POST',
      })
    },
    onSuccess: (d) => {
      setNotice(d.revoked > 0 ? `Signed out ${d.revoked} other session(s).` : 'No other active sessions.')
      setError('')
      invalidate()
    },
    onError: (e: Error) => {
      setError(e.message)
      setNotice('')
    },
  })

  const otherCount = sessions.filter((s) => !s.is_current).length
  const liveSessions = sessions.filter((s) => !s.is_pending_2fa)

  const doRevokeOther = () => {
    if (
      confirm(
        `Sign out all ${otherCount} other active session(s)? Any device still holding one of those sessions will need to sign in again.`,
      )
    ) {
      revokeOthersMutation.mutate()
    }
  }

  return (
    <Panel title="Active sessions">
      <div className="px-5 py-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-zinc-500 max-w-2xl">
            Devices currently signed in to this account. Sessions expire automatically after{' '}
            24 hours and are rejected after 30 minutes of inactivity — revoke one early if you
            see a device you don't recognize.
          </p>
          <GhostButton
            onClick={doRevokeOther}
            disabled={otherCount === 0 || revokeOthersMutation.isPending}
            className="shrink-0"
          >
            <IconLogout size={14} stroke={1.6} aria-hidden="true" />
            {revokeOthersMutation.isPending ? 'Signing out…' : `Sign out ${otherCount} other(s)`}
          </GhostButton>
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}
        {notice && <p className="text-teal-400 text-sm">{notice}</p>}

        {isLoading ? (
          <div className="h-24 w-full wgc-skeleton rounded-lg" />
        ) : liveSessions.length === 0 ? (
          <EmptyState title="No active sessions" hint="Sessions you open will appear here." />
        ) : (
          <ul className="divide-y divide-zinc-800/60 border border-zinc-800 rounded-lg">
            {liveSessions.map((s) => {
              const Icon = deviceIcon(s.user_agent)
              return (
                <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-800/70 text-zinc-400">
                    <Icon size={18} stroke={1.6} aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm text-zinc-200 font-medium">
                        {deviceLabel(s.user_agent)}
                      </span>
                      {s.is_current && <Badge tone="accent">This device</Badge>}
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <span className="inline-flex items-center gap-1">
                        <IconWorld size={11} stroke={1.6} aria-hidden="true" />
                        {s.ip_address || '—'}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <IconClock size={11} stroke={1.6} aria-hidden="true" />
                        active {ago(s.last_seen_at || s.created_at)} · signed in {ago(s.created_at)}
                      </span>
                      <span className="text-zinc-600">expires {expiresIn(s.expires_at)}</span>
                    </div>
                  </div>
                  {!s.is_current && (
                    <button
                      onClick={() => revokeMutation.mutate(s.id)}
                      disabled={revokeMutation.isPending}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Panel>
  )
}

import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  IconClock,
  IconCode,
  IconMail,
  IconSend,
  IconSettings,
  IconShieldLock,
} from '@tabler/icons-react'
import { PageHeader, PrimaryButton, GhostButton, inputCls, labelCls } from '../../lib/ui'
import { apiJson } from '../../lib/api'
import { EmailTemplatesSection } from '../../components/EmailTemplatesSection'
import { getTimezone, setTimezone } from '../../lib/timezone'

interface SMTPConfig {
  host: string
  port: number
  username: string
  from: string
  configured: boolean
  password_set: boolean
}


export const Route = createFileRoute('/_authenticated/config')({
  component: ConfigPage,
})

type ConfigTab = 'smtp' | 'templates' | 'timezone' | 'security'

// Each tab keeps its own scroll container so the page never grows into one
// long column as configuration sections are added. Sections that belong to a
// tab (e.g. future SMTP relay / send limits) slot in beneath it.
const TABS: { id: ConfigTab; label: string; icon: React.ComponentType<{ size?: number; stroke?: number; className?: string }> }[] = [
  { id: 'smtp', label: 'Email (SMTP)', icon: IconSettings },
  { id: 'templates', label: 'Email templates', icon: IconCode },
  { id: 'timezone', label: 'Timezone', icon: IconClock },
  { id: 'security', label: 'Security', icon: IconShieldLock },
]

export function ConfigPage() {
  const [tab, setTab] = useState<ConfigTab>('smtp')

  return (
    <div>
      <PageHeader
        title="Configuration"
        description="Outbound email (SMTP), the templates the console uses for invites, the display timezone for reports and logs, and security policy."
      />

      {/* Tab bar */}
      <div className="mb-6 flex flex-wrap items-center gap-1 border-b border-zinc-800">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={active ? 'page' : undefined}
              className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors -mb-px ${
                active
                  ? 'border-teal-500 text-teal-300'
                  : 'border-transparent text-zinc-500 hover:text-zinc-200 hover:border-zinc-700'
              }`}
            >
              <Icon size={16} stroke={1.7} aria-hidden="true" />
              {label}
            </button>
          )
        })}
      </div>

      {tab === 'smtp' ? (
        <SmtpSettings />
      ) : tab === 'templates' ? (
        <EmailTemplatesSection />
      ) : tab === 'security' ? (
        <SecuritySettings />
      ) : (
        <TimezoneSettings />
      )}
    </div>
  )
}

function SmtpSettings() {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ host: '', port: '587', username: '', password: '', from: '' })
  const [testTo, setTestTo] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const { data: smtp, isLoading } = useQuery<SMTPConfig>({
    queryKey: ['smtp-config'],
    queryFn: async () => {
      return apiJson<SMTPConfig>('/api/config/smtp')
    },
  })

  useEffect(() => {
    if (smtp) {
      setForm((f) => ({
        ...f,
        host: smtp.host,
        port: String(smtp.port || 587),
        username: smtp.username,
        from: smtp.from,
      }))
    }
  }, [smtp])

  const saveMutation = useMutation({
    mutationFn: async () => {
      return apiJson('/api/config/smtp', {
        method: 'PATCH',
        body: {
          host: form.host,
          port: Number(form.port),
          username: form.username,
          password: form.password,
          from: form.from,
        },
      })
    },
    onSuccess: () => {
      setMessage('SMTP settings saved.')
      setError('')
      setForm((f) => ({ ...f, password: '' }))
      queryClient.invalidateQueries({ queryKey: ['smtp-config'] })
    },
    onError: (e: Error) => {
      setError(e.message)
      setMessage('')
    },
  })

  const testMutation = useMutation({
    mutationFn: async () => {
      return apiJson('/api/config/email/test', {
        method: 'POST',
        body: { to: testTo },
      })
    },
    onSuccess: () => {
      setMessage(`Test email sent to ${testTo}.`)
      setError('')
    },
    onError: (e: Error) => {
      setError(e.message)
      setMessage('')
    },
  })

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  return (
    <div className="max-w-xl">
      <div className="border border-zinc-800 rounded-lg bg-zinc-900/50 p-6">
        <div className="flex items-center gap-2 mb-1">
          <IconMail size={18} stroke={1.6} className="text-zinc-400" aria-hidden="true" />
          <h2 className="text-base font-semibold text-zinc-100">Email (SMTP)</h2>
        </div>
        <p className="text-sm text-zinc-400 mb-4">
          Used for user invitations and admin invites. Saved in the console database — no server
          file edits needed.
        </p>

        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
        {message && <p className="text-teal-400 text-sm mb-3">{message}</p>}

        {isLoading ? (
          <p className="text-zinc-400 text-sm">Loading…</p>
        ) : (
          <div className="space-y-4">
            <div>
              <label htmlFor="smtpHost" className={labelCls}>
                SMTP host
              </label>
              <input
                id="smtpHost"
                value={form.host}
                onChange={set('host')}
                placeholder="smtp.example.com"
                className={inputCls}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="smtpPort" className={labelCls}>
                  Port
                </label>
                <input
                  id="smtpPort"
                  value={form.port}
                  onChange={set('port')}
                  className={inputCls}
                />
              </div>
              <div>
                <label htmlFor="smtpUser" className={labelCls}>
                  Username
                </label>
                <input
                  id="smtpUser"
                  value={form.username}
                  onChange={set('username')}
                  className={inputCls}
                />
              </div>
            </div>
            <div>
              <label htmlFor="smtpPass" className={labelCls}>
                Password
                {smtp?.password_set && !form.password && (
                  <span className="text-zinc-500 font-normal"> (stored — leave empty to keep)</span>
                )}
              </label>
              <input
                id="smtpPass"
                type="password"
                value={form.password}
                onChange={set('password')}
                autoComplete="new-password"
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="smtpFrom" className={labelCls}>
                From address
              </label>
              <input
                id="smtpFrom"
                value={form.from}
                onChange={set('from')}
                placeholder="no-reply@example.com"
                className={inputCls}
              />
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <PrimaryButton onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? 'Saving…' : 'Save SMTP Settings'}
              </PrimaryButton>
              {smtp?.configured && (
                <div className="flex items-center gap-2">
                  <input
                    value={testTo}
                    onChange={(e) => setTestTo(e.target.value)}
                    placeholder="test@example.com"
                    className="bg-zinc-800/60 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                  <GhostButton
                    onClick={() => testTo && testMutation.mutate()}
                    disabled={!testTo || testMutation.isPending}
                  >
                    <IconSend size={15} stroke={1.6} aria-hidden="true" />
                    {testMutation.isPending ? 'Sending…' : 'Send Test Email'}
                  </GhostButton>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Timezone — display timezone for reports, charts and logs
// ---------------------------------------------------------------------------

// IANA time zones offered in the picker, grouped for readability. Common
// zones only — the list stays short and deterministic, and any other IANA
// name can still be applied because the server validates values itself.
const ZONE_OPTIONS: [string, string[]][] = [
  [
    'UTC',
    ['UTC'],
  ],
  [
    'Asia (SEA & East Asia)',
    [
      'Asia/Kuala_Lumpur',
      'Asia/Singapore',
      'Asia/Jakarta',
      'Asia/Bangkok',
      'Asia/Ho_Chi_Minh',
      'Asia/Manila',
      'Asia/Shanghai',
      'Asia/Hong_Kong',
      'Asia/Taipei',
      'Asia/Tokyo',
      'Asia/Seoul',
      'Asia/Kolkata',
      'Asia/Dubai',
    ],
  ],
  [
    'Australia & Pacific',
    [
      'Australia/Perth',
      'Australia/Sydney',
      'Australia/Melbourne',
      'Australia/Brisbane',
      'Pacific/Auckland',
    ],
  ],
  [
    'Europe & Africa',
    [
      'Europe/London',
      'Europe/Paris',
      'Europe/Berlin',
      'Europe/Amsterdam',
      'Europe/Madrid',
      'Europe/Rome',
      'Europe/Stockholm',
      'Europe/Warsaw',
      'Europe/Istanbul',
      'Europe/Moscow',
      'Africa/Cairo',
      'Africa/Johannesburg',
      'Africa/Lagos',
      'Africa/Nairobi',
    ],
  ],
  [
    'Americas',
    [
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'America/Phoenix',
      'America/Anchorage',
      'America/Toronto',
      'America/Vancouver',
      'America/Mexico_City',
      'America/Sao_Paulo',
      'America/Argentina/Buenos_Aires',
    ],
  ],
]

// Zones without a '/' (like 'UTC') keep their full name as the short label.
function zoneLabel(z: string): string {
  const idx = z.indexOf('/')
  return idx === -1 ? z : z.slice(idx + 1)
}

function zoneOffset(name: string): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZone: name,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date())
    return parts.find((p) => p.type === 'timeZoneName')?.value || ''
  } catch {
    return ''
  }
}

function TimezoneSettings() {
  const queryClient = useQueryClient()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const { data: cfg, isLoading } = useQuery<{ timezone: string }>({
    queryKey: ['timezone-config'],
    queryFn: async () => {
      return apiJson<{ timezone: string }>('/api/config/timezone')
    },
  })
  const current = cfg?.timezone ?? getTimezone()

  // Draft while editing; committed on Save. Saving also updates the
  // module-wide cache so every page formats in the new zone immediately.
  const [draft, setDraft] = useState(current)
  useEffect(() => setDraft(current), [current])

  const saveMutation = useMutation({
    mutationFn: async (zone: string) => {
      return apiJson('/api/config/timezone', {
        method: 'PATCH',
        body: { timezone: zone },
      })
    },
    onSuccess: (_d, zone) => {
      setTimezone(zone)
      queryClient.invalidateQueries({ queryKey: ['timezone-config'] })
      setMessage(
        zone
          ? `Timezone set to ${zone}. Reports and timestamps across the console now use it.`
          : 'Timezone cleared — each viewer sees times in their own browser timezone.',
      )
      setError('')
    },
    onError: (e: Error) => {
      setError(e.message)
      setMessage('')
    },
  })

  const browserZone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    } catch {
      return ''
    }
  })()

  // The curated zone groups (stable list).
  const groups = ZONE_OPTIONS

  return (
    <div className="max-w-xl">
      <div className="border border-zinc-800 rounded-lg bg-zinc-900/50 p-6">
        <div className="flex items-center gap-2 mb-1">
          <IconClock size={18} stroke={1.6} className="text-zinc-400" aria-hidden="true" />
          <h2 className="text-base font-semibold text-zinc-100">Timezone</h2>
        </div>
        <p className="text-sm text-zinc-400 mb-4">
          The display timezone for reports, charts and logs across the console. Picked once by an
          admin, it applies to every viewer — so the usage report, traffic chart and web-activity
          records all align to one clock.
        </p>

        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
        {message && <p className="text-teal-400 text-sm mb-3">{message}</p>}

        {isLoading ? (
          <p className="text-zinc-400 text-sm">Loading…</p>
        ) : (
          <div className="space-y-5">
            {/* Current + picker */}
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-zinc-500">Currently</span>
              <span className="text-zinc-100 font-mono tabular-nums">
                {current ? `${current} (${zoneOffset(current) || 'UTC'})` : 'Browser timezone'}
              </span>
            </div>

            <div>
              <label htmlFor="tzZone" className={labelCls}>
                Timezone
              </label>
              <select
                id="tzZone"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className={inputCls}
              >
                <option value="">Browser timezone (each viewer sees their own)</option>
                {groups.map(([groupLabel, zones]) => (
                  <optgroup key={groupLabel} label={groupLabel}>
                    {zones.map((z) => {
                      const off = zoneOffset(z)
                      return (
                        <option key={z} value={z}>
                          {zoneLabel(z)} {off ? `(${off})` : ''}
                        </option>
                      )
                    })}
                  </optgroup>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-zinc-600">
                Empty = follow each viewer's browser. Offsets shown are the current local time's; the
                stored value is the IANA zone name (e.g. Asia/Kuala_Lumpur).
              </p>
            </div>

            {/* Preview: what 20:00 UTC looks like in the chosen zone */}
            {draft !== '' && (
              <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2.5 text-sm">
                <span className="text-zinc-500">20:00 UTC is</span>{' '}
                <span className="text-teal-300 font-mono tabular-nums">
                  {new Intl.DateTimeFormat(undefined, {
                    timeZone: draft,
                    hour: '2-digit',
                    minute: '2-digit',
                  }).format(new Date('2026-01-15T20:00:00Z'))}
                </span>{' '}
                <span className="text-zinc-600">in {draft}</span>
              </div>
            )}

            {browserZone && current && current !== browserZone && (
              <p className="text-xs text-zinc-500">
                This viewer's browser is {browserZone} — timestamps will render in{' '}
                <span className="text-zinc-300 font-mono">{current}</span> instead.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <PrimaryButton
                onClick={() => saveMutation.mutate(draft)}
                disabled={saveMutation.isPending || draft === current}
              >
                {saveMutation.isPending ? 'Saving…' : 'Save timezone'}
              </PrimaryButton>
              <GhostButton
                onClick={() => saveMutation.mutate('')}
                disabled={current === '' || saveMutation.isPending}
              >
                Reset to browser timezone
              </GhostButton>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// SecuritySettings — 2FA step-up grace window (super_admin editable).
//
// After an admin passes one step-up 2FA code, their same session is trusted
// for the other sensitive actions for this many minutes. 0 = ask every time.
function SecuritySettings() {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('0')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const { data: me } = useQuery<{ role: string }>({
    queryKey: ['me'],
    queryFn: async () => {
      return apiJson<{ role: string }>('/api/admins/me')
    },
  })
  const isSuperAdmin = me?.role === 'super_admin'

  const { data: cfg, isLoading } = useQuery<{ step_up_minutes: number }>({
    queryKey: ['stepup-config'],
    queryFn: async () => {
      return apiJson<{ step_up_minutes: number }>('/api/config/step-up')
    },
  })
  const current = cfg?.step_up_minutes ?? 0

  useEffect(() => {
    setDraft(String(current))
  }, [current])

  const saveMutation = useMutation({
    mutationFn: async (minutes: number) => {
      return apiJson('/api/config/step-up', {
        method: 'PATCH',
        body: { step_up_minutes: minutes },
      })
    },
    onSuccess: (_d, minutes) => {
      queryClient.invalidateQueries({ queryKey: ['stepup-config'] })
      setMessage(
        minutes > 0
          ? `Saved — after a 2FA check, your session is trusted for ${minutes} minute${minutes === 1 ? '' : 's'}.`
          : 'Saved — every sensitive action now asks for a 2FA code.',
      )
      setError('')
    },
    onError: (e: Error) => {
      setError(e.message)
      setMessage('')
    },
  })

  const parsed = parseInt(draft, 10)
  const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1440

  return (
    <div className="max-w-xl">
      <div className="border border-zinc-800 rounded-lg bg-zinc-900/50 p-6">
        <div className="flex items-center gap-2 mb-1">
          <IconShieldLock size={18} stroke={1.6} className="text-zinc-400" aria-hidden="true" />
          <h2 className="text-base font-semibold text-zinc-100">2FA step-up window</h2>
        </div>
        <p className="text-sm text-zinc-400 mb-4">
          Sensitive actions — editing or deleting servers, viewing host setup, deleting nodes,
          re-issuing join commands, backup download/restore — ask for your authenticator code. Set
          a window here to skip re-entering it on the same session for that long after one check.
          <span className="block mt-1 text-zinc-500">
            0 = ask every time (strictest). The grace never carries across a new login or another
            admin's session.
          </span>
        </p>

        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
        {message && <p className="text-teal-400 text-sm mb-3">{message}</p>}

        {isLoading ? (
          <p className="text-zinc-400 text-sm">Loading…</p>
        ) : (
          <div className="space-y-5">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-zinc-500">Currently</span>
              <span className="text-zinc-100 font-mono tabular-nums">
                {current > 0 ? `trusted for ${current} minute${current === 1 ? '' : 's'}` : 'ask every time (0)'}
              </span>
            </div>

            {isSuperAdmin ? (
              <div>
                <label htmlFor="stepUpMinutes" className={labelCls}>
                  Minutes to trust after a 2FA check
                </label>
                <div className="flex items-center gap-3">
                  <input
                    id="stepUpMinutes"
                    type="number"
                    min={0}
                    max={1440}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className={`${inputCls} max-w-[10rem]`}
                  />
                  <PrimaryButton
                    onClick={() => valid && saveMutation.mutate(parsed)}
                    disabled={!valid || saveMutation.isPending || parsed === current}
                  >
                    {saveMutation.isPending ? 'Saving…' : 'Save'}
                  </PrimaryButton>
                </div>
                <p className="mt-1.5 text-xs text-zinc-600">
                  Minutes, 0–1440 (a 24h cap). Applied to every admin's session — super_admin only.
                </p>
              </div>
            ) : (
              <p className="text-xs text-amber-400/90">
                Only a super admin can change the 2FA step-up window.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

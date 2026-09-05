import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  IconCode,
  IconMail,
  IconSend,
  IconSettings,
} from '@tabler/icons-react'
import { PageHeader, PrimaryButton, GhostButton, inputCls, labelCls } from '../../lib/ui'
import { EmailTemplatesSection } from '../../components/EmailTemplatesSection'

interface SMTPConfig {
  host: string
  port: number
  username: string
  from: string
  configured: boolean
  password_set: boolean
}

const authH = { Authorization: localStorage.getItem('token')! }

export const Route = createFileRoute('/_authenticated/config')({
  component: ConfigPage,
})

type ConfigTab = 'smtp' | 'templates'

// Each tab keeps its own scroll container so the page never grows into one
// long column as configuration sections are added. Sections that belong to a
// tab (e.g. future SMTP relay / send limits) slot in beneath it.
const TABS: { id: ConfigTab; label: string; icon: React.ComponentType<{ size?: number; stroke?: number; className?: string }> }[] = [
  { id: 'smtp', label: 'Email (SMTP)', icon: IconSettings },
  { id: 'templates', label: 'Email templates', icon: IconCode },
]

function ConfigPage() {
  const [tab, setTab] = useState<ConfigTab>('smtp')

  return (
    <div>
      <PageHeader
        title="Configuration"
        description="Outbound email (SMTP) and the templates the console uses for invites and peer configs."
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

      {tab === 'smtp' ? <SmtpSettings /> : <EmailTemplatesSection />}
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
      const res = await fetch('/api/config/smtp', {
        headers: { Authorization: localStorage.getItem('token')! },
      })
      if (!res.ok) throw new Error('Failed to fetch SMTP config')
      return res.json()
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
      const res = await fetch('/api/config/smtp', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: localStorage.getItem('token')!,
        },
        body: JSON.stringify({
          host: form.host,
          port: Number(form.port),
          username: form.username,
          password: form.password,
          from: form.from,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to save SMTP config')
      }
      return res.json()
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
      const res = await fetch('/api/config/email/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: localStorage.getItem('token')!,
        },
        body: JSON.stringify({ to: testTo }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to send test email')
      }
      return res.json()
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

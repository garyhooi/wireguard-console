import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

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

function ConfigPage() {
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
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">Configuration</h1>

      <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6 max-w-xl">
        <h2 className="text-lg font-semibold text-white mb-1">Email (SMTP)</h2>
        <p className="text-sm text-neutral-400 mb-4">
          Used for user invitations and admin invites. Saved in the console database — no server
          file edits needed.
        </p>

        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
        {message && <p className="text-teal-400 text-sm mb-3">{message}</p>}
        {isLoading ? (
          <p className="text-neutral-400 text-sm">Loading…</p>
        ) : (
          <div className="space-y-4">
            <div>
              <label htmlFor="smtpHost" className="block text-sm font-medium text-neutral-400 mb-2">
                SMTP host
              </label>
              <input
                id="smtpHost"
                value={form.host}
                onChange={set('host')}
                placeholder="smtp.example.com"
                className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="smtpPort" className="block text-sm font-medium text-neutral-400 mb-2">
                  Port
                </label>
                <input
                  id="smtpPort"
                  value={form.port}
                  onChange={set('port')}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <div>
                <label htmlFor="smtpUser" className="block text-sm font-medium text-neutral-400 mb-2">
                  Username
                </label>
                <input
                  id="smtpUser"
                  value={form.username}
                  onChange={set('username')}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
            </div>
            <div>
              <label htmlFor="smtpPass" className="block text-sm font-medium text-neutral-400 mb-2">
                Password
                {smtp?.password_set && !form.password && (
                  <span className="text-neutral-500 font-normal"> (stored — leave empty to keep)</span>
                )}
              </label>
              <input
                id="smtpPass"
                type="password"
                value={form.password}
                onChange={set('password')}
                autoComplete="new-password"
                className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>
            <div>
              <label htmlFor="smtpFrom" className="block text-sm font-medium text-neutral-400 mb-2">
                From address
              </label>
              <input
                id="smtpFrom"
                value={form.from}
                onChange={set('from')}
                placeholder="no-reply@example.com"
                className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                className="bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md disabled:opacity-50"
              >
                {saveMutation.isPending ? 'Saving…' : 'Save SMTP Settings'}
              </button>
              {smtp?.configured && (
                <div className="flex items-center gap-2">
                  <input
                    value={testTo}
                    onChange={(e) => setTestTo(e.target.value)}
                    placeholder="test@example.com"
                    className="bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                  <button
                    onClick={() => testTo && testMutation.mutate()}
                    disabled={!testTo || testMutation.isPending}
                    className="bg-neutral-700 hover:bg-neutral-600 text-white text-sm font-medium py-2 px-3 rounded-md disabled:opacity-50"
                  >
                    {testMutation.isPending ? 'Sending…' : 'Send Test Email'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
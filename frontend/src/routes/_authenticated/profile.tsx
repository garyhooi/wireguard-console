import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { IconShieldLock } from '@tabler/icons-react'
import {
  Badge,
  GhostButton,
  PageHeader,
  Panel,
  PrimaryButton,
  inputCls,
  labelCls,
} from '../../lib/ui'

interface Me {
  id: string
  email: string
  role: string
  totp_enabled: boolean
  status: string
  created_at: string
}

export const Route = createFileRoute('/_authenticated/profile')({
  component: ProfilePage,
})

const auth = { Authorization: localStorage.getItem('token')! }

function ProfilePage() {
  const queryClient = useQueryClient()
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' })
  const [pwMsg, setPwMsg] = useState('')
  const [pwErr, setPwErr] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [totpMsg, setTotpMsg] = useState('')
  const [totpErr, setTotpErr] = useState('')

  const { data: me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: async () => {
      const res = await fetch('/api/admins/me', { headers: auth })
      if (!res.ok) throw new Error('Failed to load profile')
      return res.json()
    },
  })

  const passwordMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/admins/me/password', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: pw.current, new_password: pw.next }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to change password')
      }
    },
    onSuccess: () => {
      setPwMsg('Password updated.')
      setPwErr('')
      setPw({ current: '', next: '', confirm: '' })
    },
    onError: (e: Error) => {
      setPwErr(e.message)
      setPwMsg('')
    },
  })

  const disable2FAMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/auth/2fa/disable', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: totpCode }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to disable 2FA')
      }
    },
    onSuccess: () => {
      setTotpMsg('2FA disabled.')
      setTotpErr('')
      setTotpCode('')
      queryClient.invalidateQueries({ queryKey: ['me'] })
    },
    onError: (e: Error) => {
      setTotpErr(e.message)
      setTotpMsg('')
    },
  })

  return (
    <div>
      <PageHeader
        title="Profile"
        description="Manage your console account: password and two-factor authentication."
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel title="Account">
          <div className="px-5 py-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-500">Email</span>
              <span className="text-sm text-zinc-200 font-mono">{me?.email}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-500">Role</span>
              <Badge tone={me?.role === 'super_admin' ? 'accent' : me?.role === 'admin' ? 'good' : 'neutral'}>
                {me?.role || 'admin'}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-500">2FA</span>
              <Badge tone={me?.totp_enabled ? 'good' : 'warn'}>
                {me?.totp_enabled ? 'enabled' : 'off'}
              </Badge>
            </div>
            <p className="text-xs text-zinc-600 pt-2">
              {me?.totp_enabled
                ? 'Two-factor authentication is enabled.'
                : 'Two-factor authentication is not enabled — enroll it now.'}
            </p>
            {!me?.totp_enabled && (
              <div className="pt-1">
                <Link
                  to="/2fa-setup"
                  className="inline-flex items-center gap-2 bg-teal-700 hover:bg-teal-600 text-white text-sm font-medium py-2 px-4 rounded-md transition-colors"
                >
                  <IconShieldLock size={16} stroke={1.6} aria-hidden="true" />
                  Enroll 2FA
                </Link>
              </div>
            )}
          </div>
        </Panel>

        <Panel title="Change password">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (pw.next !== pw.confirm) {
                setPwErr('New passwords do not match')
                return
              }
              passwordMutation.mutate()
            }}
            className="px-5 py-4 space-y-4"
          >
            {pwErr && <p className="text-red-400 text-sm">{pwErr}</p>}
            {pwMsg && <p className="text-teal-400 text-sm">{pwMsg}</p>}
            <div>
              <label className={labelCls}>Current password</label>
              <input
                type="password"
                required
                className={inputCls}
                value={pw.current}
                onChange={(e) => setPw((f) => ({ ...f, current: e.target.value }))}
              />
            </div>
            <div>
              <label className={labelCls}>New password</label>
              <input
                type="password"
                required
                className={inputCls}
                value={pw.next}
                onChange={(e) => setPw((f) => ({ ...f, next: e.target.value }))}
              />
              <p className="text-xs text-zinc-600 mt-1">
                At least 12 characters, with upper/lowercase, a number and a special character.
              </p>
            </div>
            <div>
              <label className={labelCls}>Confirm new password</label>
              <input
                type="password"
                required
                className={inputCls}
                value={pw.confirm}
                onChange={(e) => setPw((f) => ({ ...f, confirm: e.target.value }))}
              />
            </div>
            <PrimaryButton type="submit" disabled={passwordMutation.isPending}>
              {passwordMutation.isPending ? 'Updating…' : 'Update Password'}
            </PrimaryButton>
          </form>
        </Panel>
      </div>

      {me?.totp_enabled && (
        <div className="mt-6">
          <Panel title="Two-factor authentication">
            <form
              onSubmit={(e) => {
                e.preventDefault()
                disable2FAMutation.mutate()
              }}
              className="px-5 py-4 space-y-4"
            >
              {totpErr && <p className="text-red-400 text-sm">{totpErr}</p>}
              {totpMsg && <p className="text-teal-400 text-sm">{totpMsg}</p>}
              <p className="text-sm text-zinc-400">
                Enter a current authenticator code to disable 2FA for this account.
              </p>
              <div className="flex gap-3">
                <input
                  className={inputCls + ' max-w-[180px]'}
                  placeholder="6-digit code"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                />
                <GhostButton
                  onClick={() => totpCode && disable2FAMutation.mutate()}
                  disabled={!totpCode || disable2FAMutation.isPending}
                >
                  {disable2FAMutation.isPending ? 'Disabling…' : 'Disable 2FA'}
                </GhostButton>
              </div>
            </form>
          </Panel>
        </div>
      )}
    </div>
  )
}

import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import QRCode from 'qrcode'
import { IconFingerprint, IconKey, IconPlus } from '@tabler/icons-react'
import { ActiveSessions } from '../../components/ActiveSessions'
import { ConfirmMFA } from '../../lib/ConfirmMFA'
import { apiJson } from '../../lib/api'
import {
  addPasskey,
  addTOTP,
  finishTOTP,
  getMFAStatus,
  regenerateRecoveryCodes,
  removePasskey,
  removeTOTP,
} from '../../lib/mfaClient'
import type { MFAFactor, MFAStatus } from '../../lib/mfaClient'
import {
  Badge,
  GhostButton,
  Modal,
  PageHeader,
  Panel,
  PrimaryButton,
  Skeleton,
  inputCls,
  labelCls,
} from '../../lib/ui'
import { fmtDate } from '../../lib/timezone'

interface Me {
  id: string
  email: string
  role: string
  totp_enabled: boolean
  status: string
  created_at: string
  mfa_enabled: boolean
  mfa_methods: string[]
  passkey_count: number
  recovery_codes_remaining: number
  passkey_available: boolean
  require_methods: string
}

/** One pending privileged action awaiting an MFA step-up proof. */
interface PendingMFA {
  title: string
  description: string
  submitLabel: string
  /** Receives the step-up code ('' when a passkey proof authorized it). */
  run: (code: string) => Promise<void>
}

/** Recovery codes issued per generation (server constant). */
const RECOVERY_CODE_COUNT = 10

const POLICY_LABELS: Record<string, string> = {
  any: 'any one factor',
  totp: 'an authenticator app',
  passkey: 'a passkey',
  both: 'a passkey and an authenticator app',
}

/** Map a server MFA refusal to copy an admin can act on. */
function friendlyMFAError(e: unknown): Error {
  const code = e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined
  if (code === 'mfa_last_factor') {
    return new Error(
      "You can't remove your last sign-in factor. Add a passkey or an authenticator app first, then remove this one.",
    )
  }
  if (code === 'mfa_unavailable') {
    return new Error('Passkeys are not available on this deployment. Use an authenticator app instead.')
  }
  if (code === 'mfa_already_enabled') {
    return new Error('An authenticator app is already set up for your account.')
  }
  if (code === 'mfa_no_passkeys') {
    return new Error('No passkey is registered for your account yet.')
  }
  return e instanceof Error ? e : new Error('Action failed')
}

export const Route = createFileRoute('/_authenticated/profile')({
  component: ProfilePage,
})

export function ProfilePage() {
  const queryClient = useQueryClient()
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' })
  const [pwMsg, setPwMsg] = useState('')
  const [pwErr, setPwErr] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  // Pending step-up action (add/remove factor, regenerate recovery codes).
  const [stepUp, setStepUp] = useState<PendingMFA | null>(null)
  // Authenticator-app enrollment: QR/secret shown after the step-up begin.
  const [totpEnroll, setTotpEnroll] = useState<{ secret: string; otpauth_url: string } | null>(null)
  const [totpQr, setTotpQr] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [totpErr, setTotpErr] = useState('')
  const [totpBusy, setTotpBusy] = useState(false)
  // Regenerated recovery codes (shown exactly once, behind an acknowledgement).
  const [newCodes, setNewCodes] = useState<string[] | null>(null)
  const [codesAck, setCodesAck] = useState(false)
  const [codesCopied, setCodesCopied] = useState(false)

  const { data: me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: async () => {
      return apiJson<Me>('/api/admins/me')
    },
  })

  const { data: status, isLoading } = useQuery<MFAStatus>({
    queryKey: ['mfa-status'],
    queryFn: getMFAStatus,
  })

  const refreshMFA = () => {
    queryClient.invalidateQueries({ queryKey: ['mfa-status'] })
    queryClient.invalidateQueries({ queryKey: ['me'] })
  }

  const passwordMutation = useMutation({
    mutationFn: async () => {
      await apiJson('/api/admins/me/password', {
        method: 'POST',
        body: { current_password: pw.current, new_password: pw.next },
      })
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

  // ---- Factor management (every action is MFA step-up gated) -------------

  /** Wrap a gated action so server refusals read as actionable copy. */
  const stepUpAction =
    (fn: (code: string) => Promise<void>) =>
    async (code: string): Promise<void> => {
      try {
        await fn(code)
      } catch (e) {
        throw friendlyMFAError(e)
      }
    }

  const startAddPasskey = () => {
    setError('')
    setStepUp({
      title: 'Add passkey',
      description:
        'Confirm this action to register a passkey on this device. Your browser will then ask for Face ID, Touch ID, Windows Hello or a security key. Once added, this passkey can also sign you in from the login page without a password.',
      submitLabel: 'Continue',
      run: stepUpAction(async (code) => {
        await addPasskey(code)
        setNotice('Passkey added.')
        refreshMFA()
      }),
    })
  }

  const startAddTOTP = () => {
    setError('')
    setStepUp({
      title: 'Add authenticator app',
      description:
        'Confirm this action to generate a new authenticator setup key, then scan it with your authenticator app.',
      submitLabel: 'Continue',
      run: stepUpAction(async (code) => {
        const begin = await addTOTP(code)
        setTotpEnroll(begin)
        setTotpCode('')
        setTotpErr('')
        setTotpQr('')
        void QRCode.toDataURL(begin.otpauth_url, { width: 320, margin: 1 })
          .then(setTotpQr)
          .catch(() => setTotpQr(''))
      }),
    })
  }

  const startRemoveTOTP = () => {
    setError('')
    setStepUp({
      title: 'Remove authenticator app',
      description:
        'Remove the authenticator app from your account? You can still sign in with another factor. Confirm with a passkey or your current authenticator code.',
      submitLabel: 'Remove',
      run: stepUpAction(async (code) => {
        await removeTOTP(code)
        setNotice('Authenticator app removed.')
        refreshMFA()
      }),
    })
  }

  const startRemovePasskey = (factor: MFAFactor) => {
    setError('')
    setStepUp({
      title: 'Remove passkey',
      description: `Remove the passkey "${factor.label || 'this device'}"? The device will no longer be able to sign in or confirm actions with it. Confirm with a passkey or an authenticator code.`,
      submitLabel: 'Remove',
      run: stepUpAction(async (code) => {
        await removePasskey(factor.id, code)
        setNotice('Passkey removed.')
        refreshMFA()
      }),
    })
  }

  const startRegenerateRecoveryCodes = () => {
    setError('')
    setStepUp({
      title: 'Regenerate recovery codes',
      description:
        'Generate a new set of recovery codes? Every existing recovery code stops working immediately. Confirm with a passkey or an authenticator code.',
      submitLabel: 'Regenerate',
      run: stepUpAction(async (code) => {
        const codes = await regenerateRecoveryCodes(code)
        setCodesAck(false)
        setCodesCopied(false)
        setNewCodes(codes)
      }),
    })
  }

  const verifyTOTPEnrollment = async () => {
    if (!totpEnroll || totpCode.length !== 6 || totpBusy) return
    setTotpBusy(true)
    setTotpErr('')
    try {
      await finishTOTP(totpEnroll.secret, totpCode)
      setTotpEnroll(null)
      setTotpQr('')
      setTotpCode('')
      setNotice('Authenticator app added.')
      setError('')
      refreshMFA()
    } catch (e) {
      setTotpErr(friendlyMFAError(e).message)
    } finally {
      setTotpBusy(false)
    }
  }

  const copyRecoveryCodes = async () => {
    if (!newCodes) return
    try {
      await navigator.clipboard.writeText(newCodes.join('\n'))
      setCodesCopied(true)
    } catch {
      setCodesCopied(false)
    }
  }

  const downloadRecoveryCodes = () => {
    if (!newCodes) return
    const blob = new Blob([newCodes.join('\n') + '\n'], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'wgconsole-recovery-codes.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  const factors = status?.factors ?? []
  const totpFactor = factors.find((f) => f.type === 'totp')
  const passkeyFactors = factors.filter((f) => f.type === 'passkey')
  const passkeysAvailable = Boolean(status?.passkey_available)
  const anyFactor = Boolean(status?.mfa_enabled)
  // A passkey can only authorize a step-up when one is already enrolled.
  const passkeyStepUpAvailable = passkeysAvailable && passkeyFactors.length > 0
  const requiredPolicy = status?.require_methods && status.require_methods !== 'any'
    ? status.require_methods
    : ''

  return (
    <div>
      <PageHeader
        title="Profile"
        description="Manage your console account: password and multi-factor authentication."
      />

      {status && !anyFactor && (
        <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 px-5 py-4">
          <p className="text-sm font-medium text-amber-300">
            Multi-factor authentication is not set up for your account.
          </p>
          <p className="mt-1 text-sm text-amber-200/80">
            Add a passkey or an authenticator app below. A passkey can also sign you in without
            a password. Until then, sensitive console actions stay locked and your next sign-in
            will force enrollment.
          </p>
        </div>
      )}

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      {notice && <p className="mb-3 text-sm text-teal-400">{notice}</p>}

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
              <span className="text-sm text-zinc-500">MFA</span>
              <Badge tone={(me?.mfa_enabled ?? anyFactor) ? 'good' : 'warn'}>
                {(me?.mfa_enabled ?? anyFactor) ? 'enabled' : 'not set up'}
              </Badge>
            </div>
            <p className="text-xs text-zinc-600 pt-2">
              {(me?.mfa_enabled ?? anyFactor)
                ? 'Multi-factor authentication protects this account and every privileged action.'
                : 'Every admin must have at least one factor. Set it up in the panel below.'}
            </p>
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

      <div className="mt-6">
        <Panel
          title="Multi-factor authentication"
          right={
            <Badge tone={anyFactor ? 'good' : 'warn'}>{anyFactor ? 'enabled' : 'not set up'}</Badge>
          }
        >
          <div className="px-5 py-4 space-y-5">
            <p className="text-sm text-zinc-500">
              Sign in and authorize sensitive actions with a passkey, an authenticator app, or a
              one-time recovery code. A passkey can also sign you in from the login page without a
              password. At least one factor is required for every admin.
              {requiredPolicy ? (
                <span className="block mt-1 text-amber-400/90">
                  Console policy requires {POLICY_LABELS[status?.require_methods || 'any']}.
                </span>
              ) : null}
            </p>

            {isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            ) : (
              <>
                <ul className="divide-y divide-zinc-800/60 border border-zinc-800 rounded-lg">
                  <li className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-800/70 text-zinc-400">
                      <IconKey size={18} stroke={1.6} aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-zinc-200">Authenticator app</span>
                        {status?.totp_enabled ? (
                          <Badge tone="good">enabled</Badge>
                        ) : (
                          <Badge tone="neutral">not set up</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {totpFactor
                          ? `Added ${fmtDate(totpFactor.created_at)}${totpFactor.last_used_at ? ` · last used ${fmtDate(totpFactor.last_used_at)}` : ''}`
                          : 'Google Authenticator, Authy, 1Password, or any other TOTP app.'}
                      </p>
                    </div>
                    {status?.totp_enabled && (
                      <button
                        type="button"
                        onClick={startRemoveTOTP}
                        className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
                      >
                        Remove
                      </button>
                    )}
                  </li>

                  {passkeyFactors.map((factor) => (
                    <li key={factor.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-800/70 text-zinc-400">
                        <IconFingerprint size={18} stroke={1.6} aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-zinc-200">
                            {factor.label || 'Passkey'}
                          </span>
                          <Badge tone="accent">passkey</Badge>
                          {factor.attachment && (
                            <span className="text-xs text-zinc-600">
                              {factor.attachment === 'platform'
                                ? 'platform authenticator'
                                : factor.attachment === 'cross-platform'
                                  ? 'security key'
                                  : factor.attachment}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-zinc-500">
                          Added {fmtDate(factor.created_at)}
                          {factor.last_used_at ? ` · last used ${fmtDate(factor.last_used_at)}` : ' · never used'}
                          {factor.backup_eligible ? ' · synced/backed up' : ''}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => startRemovePasskey(factor)}
                        className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
                      >
                        Remove
                      </button>
                    </li>
                  ))}

                  {passkeyFactors.length === 0 && (
                    <li className="px-4 py-3 text-xs text-zinc-600">
                      No passkeys registered yet. A passkey is phishing-resistant, faster than
                      typing a code, and can sign you in without a password.
                    </li>
                  )}
                </ul>

                <div className="flex flex-wrap items-center gap-3">
                  <PrimaryButton
                    onClick={startAddPasskey}
                    disabled={!passkeysAvailable}
                  >
                    <IconPlus size={15} stroke={1.8} aria-hidden="true" />
                    Add passkey
                  </PrimaryButton>
                  <GhostButton onClick={startAddTOTP} disabled={Boolean(status?.totp_enabled)}>
                    <IconPlus size={15} stroke={1.8} aria-hidden="true" />
                    {status?.totp_enabled ? 'Authenticator app enabled' : 'Add authenticator app'}
                  </GhostButton>
                </div>
                {!passkeysAvailable && (
                  <p className="text-xs text-zinc-500">
                    Passkeys are unavailable on this deployment
                    {status?.passkey_reason ? ` (${status.passkey_reason})` : ''} — use an
                    authenticator app instead.
                  </p>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-4">
                  <div>
                    <p className="text-sm text-zinc-300">Recovery codes</p>
                    <p className="text-xs text-zinc-500">
                      {status?.recovery_codes_remaining ?? 0} of {RECOVERY_CODE_COUNT} recovery
                      codes remaining. Each code signs you in once if you lose access to your other
                      factors.
                    </p>
                  </div>
                  <GhostButton onClick={startRegenerateRecoveryCodes}>
                    Regenerate recovery codes
                  </GhostButton>
                </div>
              </>
            )}
          </div>
        </Panel>
      </div>

      <div className="mt-6">
        <ActiveSessions />
      </div>

      {/* Step-up gate for factor management. */}
      <ConfirmMFA
        open={stepUp !== null}
        onClose={() => setStepUp(null)}
        title={stepUp?.title || 'Confirm with MFA'}
        description={stepUp?.description}
        submitLabel={stepUp?.submitLabel}
        onSubmit={stepUp ? stepUp.run : null}
        passkeyAvailable={passkeyStepUpAvailable}
      />

      {/* Authenticator-app enrollment: QR + first code. */}
      <Modal
        open={totpEnroll !== null}
        onClose={() => {
          setTotpEnroll(null)
          setTotpQr('')
          setTotpCode('')
          setTotpErr('')
        }}
        title="Add authenticator app"
        className="max-w-md"
      >
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">
            Scan this QR code with your authenticator app, or enter the setup key manually. Then
            enter the 6-digit code the app shows to finish.
          </p>
          <div className="flex justify-center">
            {totpQr ? (
              <img
                src={totpQr}
                alt="Authenticator setup QR code"
                width={220}
                height={220}
                className="rounded-md bg-white p-2"
              />
            ) : (
              <Skeleton className="h-52 w-52" />
            )}
          </div>
          <div>
            <label className={labelCls}>Setup key</label>
            <p className="break-all font-mono text-sm text-zinc-300">{totpEnroll?.secret}</p>
          </div>
          <div>
            <label htmlFor="mfaTotpCode" className={labelCls}>
              6-digit code from the app
            </label>
            <input
              id="mfaTotpCode"
              type="text"
              inputMode="numeric"
              maxLength={6}
              autoFocus
              className={`${inputCls} text-center text-2xl tracking-widest font-mono`}
              placeholder="000000"
              value={totpCode}
              onChange={(e) => {
                setTotpCode(e.target.value.replace(/\D/g, ''))
                setTotpErr('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void verifyTOTPEnrollment()
              }}
            />
          </div>
          {totpErr && <p className="text-sm text-red-400">{totpErr}</p>}
          <div className="flex justify-end gap-3 pt-1">
            <GhostButton
              onClick={() => {
                setTotpEnroll(null)
                setTotpQr('')
                setTotpCode('')
                setTotpErr('')
              }}
              disabled={totpBusy}
            >
              Cancel
            </GhostButton>
            <PrimaryButton
              onClick={() => void verifyTOTPEnrollment()}
              disabled={totpBusy || totpCode.length !== 6}
            >
              {totpBusy ? 'Verifying…' : 'Verify & enable'}
            </PrimaryButton>
          </div>
        </div>
      </Modal>

      {/* Regenerated recovery codes — shown exactly once. */}
      <Modal
        open={newCodes !== null}
        onClose={() => setNewCodes(null)}
        title="Save your recovery codes"
        className="max-w-lg"
      >
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">
            These codes are shown only once. Each can be used one time if you lose access to your
            passkey or authenticator app. Store them somewhere safe.
          </p>
          <div className="grid grid-cols-2 gap-2 rounded-md border border-zinc-800 bg-zinc-950/60 p-4 font-mono text-sm text-zinc-200">
            {newCodes?.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <GhostButton onClick={() => void copyRecoveryCodes()}>
              {codesCopied ? 'Copied' : 'Copy codes'}
            </GhostButton>
            <GhostButton onClick={downloadRecoveryCodes}>Download as .txt</GhostButton>
          </div>
          <label className="flex items-start gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={codesAck}
              onChange={(e) => setCodesAck(e.target.checked)}
            />
            I have saved these recovery codes somewhere safe.
          </label>
          <div className="flex justify-end">
            <PrimaryButton
              onClick={() => {
                setNewCodes(null)
                setCodesAck(false)
              }}
              disabled={!codesAck}
            >
              Done
            </PrimaryButton>
          </div>
        </div>
      </Modal>
    </div>
  )
}

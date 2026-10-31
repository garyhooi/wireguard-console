import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { GhostButton, Modal, PrimaryButton, inputCls, labelCls } from './ui'
import { getMFAStatus, startPasskeyStepUp } from './mfaClient'
import { isMFAEnrollmentRequired } from './api'

/**
 * ConfirmMFA — step-up authentication modal for sensitive actions
 * (reset another admin's MFA/password, change email / role, download /
 * restore backup, edit servers/nodes, change security policy, manage the
 * account's own factors).
 *
 * The acting admin proves it is really them, either with a passkey
 * (preferred — the browser prompt is followed by an empty-code action call,
 * authorized by the server's one-shot fresh step-up stamp) or with a
 * 6-digit authenticator code / 12-character recovery code. The server
 * verifies the proof before performing the action. Rendered by pages that
 * hold the pending action, e.g.:
 *
 *   const [pending, setPending] = useState<null | (() => Promise<void>)>(null)
 *   ...
 *   <button onClick={() => setPending(() => async () => { await doThing(code) })} />
 *   <ConfirmMFA open={pending !== null} onClose={() => setPending(null)}
 *              title="Confirm with MFA" onSubmit={pending} />
 *
 * The parent stores the *action factory* (it receives the code — '' after a
 * passkey proof) so the modal can run it with the proof the admin provided.
 */

interface ConfirmMFAProps {
  open: boolean
  title: string
  description?: string
  /**
   * Action factory: receives the step-up code, returns the fetch promise.
   * Passed '' when the admin proved themselves with a passkey (the server's
   * fresh step-up stamp authorizes exactly one such action).
   */
  onSubmit: ((code: string) => Promise<void>) | null
  onClose: () => void
  submitLabel?: string
  errorMessage?: string | null
  /**
   * Whether the acting admin has a passkey enrolled this browser can use.
   * Omit to let the modal ask the server (GET /api/admins/me/mfa) — pages
   * that do not already know the factor list leave it undefined.
   */
  passkeyAvailable?: boolean
}

/** Recovery codes are 12 characters, TOTP codes 6 digits — accept either. */
const MIN_CODE_LENGTH = 6

export function ConfirmMFA({
  open,
  title,
  description,
  onSubmit,
  onClose,
  submitLabel = 'Confirm',
  errorMessage,
  passkeyAvailable,
}: ConfirmMFAProps) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyMode, setBusyMode] = useState<'passkey' | 'code' | null>(null)
  const [error, setError] = useState('')
  const [enrollmentRequired, setEnrollmentRequired] = useState(false)
  const [success, setSuccess] = useState('')

  // Start every dialog clean: a previous attempt's error/success and typed
  // code must not leak into the next privileged action.
  useEffect(() => {
    if (!open) return
    setCode('')
    setError('')
    setEnrollmentRequired(false)
    setSuccess('')
  }, [open])

  // Resolve passkey availability from the server when the caller did not
  // provide it. Only runs while the modal is open, so pages pay nothing in
  // the common case.
  const { data: status } = useQuery({
    queryKey: ['mfa-status'],
    queryFn: getMFAStatus,
    enabled: open && passkeyAvailable === undefined,
    staleTime: 30_000,
    retry: false,
  })
  const hasPasskey =
    passkeyAvailable ??
    Boolean(
      status?.passkey_available &&
        (status.factors || []).some((f) => f.type === 'passkey'),
    )

  const clearFeedback = () => {
    setError('')
    setEnrollmentRequired(false)
    setSuccess('')
  }

  const close = () => {
    if (busy) return
    setCode('')
    clearFeedback()
    onClose()
  }

  /**
   * Run the gated action once the admin has proved themselves. Passkey mode
   * first performs the browser ceremony (server stamps the session), then
   * submits the action with an empty code. Code mode passes the typed code
   * to the action, which forwards it to the server with the request.
   */
  const runAction = async (mode: 'passkey' | 'code', proof: string) => {
    if (!onSubmit || busy) return
    setBusy(true)
    setBusyMode(mode)
    clearFeedback()
    try {
      if (mode === 'passkey') await startPasskeyStepUp()
      await onSubmit(proof)
      setSuccess('Done.')
      setCode('')
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verification failed')
      setEnrollmentRequired(isMFAEnrollmentRequired(e))
    } finally {
      setBusy(false)
      setBusyMode(null)
    }
  }

  const submitCode = () => {
    const trimmed = code.trim()
    if (trimmed.length < MIN_CODE_LENGTH) return
    void runAction('code', trimmed)
  }

  return (
    <Modal open={open} onClose={close} title={title} className="max-w-md">
      <div className="space-y-4">
        {description && <p className="text-sm text-zinc-400 leading-relaxed">{description}</p>}
        {errorMessage && <p className="text-sm text-amber-400">{errorMessage}</p>}

        {hasPasskey && (
          <div className="space-y-2">
            <PrimaryButton
              onClick={() => void runAction('passkey', '')}
              disabled={busy}
              className="w-full"
            >
              {busyMode === 'passkey' ? 'Waiting for passkey…' : 'Use passkey'}
            </PrimaryButton>
            <p className="text-xs text-zinc-600 text-center">
              Face ID, Touch ID, Windows Hello or a security key.
            </p>
            <div className="flex items-center gap-3 py-1" aria-hidden="true">
              <span className="h-px flex-1 bg-zinc-800" />
              <span className="text-xs text-zinc-600">or use a code</span>
              <span className="h-px flex-1 bg-zinc-800" />
            </div>
          </div>
        )}

        <div>
          <label htmlFor="confirm-mfa-code" className={labelCls}>
            Authenticator or recovery code
          </label>
          <input
            id="confirm-mfa-code"
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            maxLength={16}
            autoFocus
            className={`${inputCls} text-center text-2xl tracking-widest font-mono uppercase`}
            placeholder="000000"
            value={code}
            onChange={(e) => {
              // Digits for authenticator codes, letters for recovery codes —
              // strip separators/punctuation so pasted codes still work.
              setCode(e.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase())
              clearFeedback()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCode()
            }}
          />
          <p className="text-xs text-zinc-600 mt-1">
            Required to authorize this action. Enter a 6-digit authenticator code, or a
            recovery code if you have lost access to your factors.
          </p>
        </div>

        {error && !enrollmentRequired && <p className="text-sm text-red-400">{error}</p>}
        {enrollmentRequired && (
          <p className="text-sm text-amber-400">
            Multi-factor authentication must be set up in Profile before this action can be
            authorized.
          </p>
        )}
        {success && <p className="text-sm text-teal-400">{success}</p>}

        <div className="flex justify-end gap-3 pt-1">
          <GhostButton onClick={close} disabled={busy}>
            Cancel
          </GhostButton>
          <PrimaryButton
            onClick={submitCode}
            disabled={busy || code.trim().length < MIN_CODE_LENGTH}
          >
            {busyMode === 'code' ? 'Verifying…' : submitLabel}
          </PrimaryButton>
        </div>
      </div>
    </Modal>
  )
}

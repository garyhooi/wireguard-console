import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { IconAlertTriangle, IconFingerprint, IconShieldLock } from '@tabler/icons-react'
import { AuthStatusOverlay } from '../components/AuthStatusOverlay'
import { HoloPageBackground } from '../components/HoloPageBackground'
import { LoginLockoutOverlay } from '../components/LoginLockoutOverlay'
import { GhostButton, PrimaryButton, inputCls, labelCls } from '../lib/ui'
import {
  beginPasskeyLogin,
  completePasskeyLogin,
  getMFAState,
  mfaErrorCode,
  mfaErrorStatus,
  mfaRetryAfterSeconds,
  navigateTo,
  normalizeRecoveryCode,
  signOutAndRestart,
  verifyRecoveryCode,
  verifyTOTP,
  type MFAState,
} from '../lib/mfaClient'
import {
  cancelCeremony,
  detectWebAuthnSupport,
  isWebAuthnCancel,
  webAuthnErrorKey,
  webAuthnErrorMessage,
  webAuthnUnavailableMessage,
  type WebAuthnSupport,
} from '../lib/webauthn'
import { mfaCopy, mfaServerErrorCopy } from '../lib/mfaCopy'

/**
 * /mfa-verify — the login challenge after a correct password.
 *
 * The page is refresh-safe: it probes GET /api/auth/mfa/state with the
 * pending cookie on mount instead of relying on state handed over by /login.
 * Passkeys are only offered when the account has one AND this browser can run
 * a ceremony; TOTP and single-use recovery codes are always offered as
 * fallbacks so a cancelled/unsupported passkey can never trap the user.
 */

type Phase = 'loading' | 'choose' | 'expired' | 'disabled'

type BusyKind = 'totp' | 'recovery' | 'passkey' | 'leave' | null

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : ''
}

export const Route = createFileRoute('/mfa-verify')({
  component: MFAVerifyPage,
})

export function MFAVerifyPage({ successOverlayMs = 2000 }: { successOverlayMs?: number } = {}) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [state, setState] = useState<MFAState | null>(null)
  const [support, setSupport] = useState<WebAuthnSupport | null>(null)
  const [notice, setNotice] = useState('')
  const [mode, setMode] = useState<'totp' | 'recovery'>('totp')
  const [code, setCode] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const [busy, setBusy] = useState<BusyKind>(null)
  const [inlineError, setInlineError] = useState('')
  const [hint, setHint] = useState('')
  const [lockoutSeconds, setLockoutSeconds] = useState<number | null>(null)
  const [success, setSuccess] = useState(false)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      // Dismiss a browser passkey prompt that outlives the page.
      void cancelCeremony()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [nextState, nextSupport] = await Promise.all([getMFAState(), detectWebAuthnSupport()])
        if (cancelled) return
        if (nextState.pending_kind !== 'verify') {
          // Enrollment pending on a verify URL: restart cleanly.
          setPhase('expired')
          return
        }
        setState(nextState)
        setSupport(nextSupport)
        // Recovery-only accounts (no TOTP, e.g. passkeys unusable in this
        // browser) land straight on the recovery form.
        if (
          !nextState.mfa_methods?.includes('totp') &&
          nextState.mfa_methods?.includes('recovery_code')
        ) {
          setMode('recovery')
        }
        setPhase('choose')
      } catch (err) {
        if (cancelled) return
        if (mfaErrorStatus(err) === 403) {
          setNotice(errorMessage(err))
          setPhase('disabled')
          return
        }
        setNotice(mfaServerErrorCopy(mfaErrorCode(err)) ?? '')
        setPhase('expired')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const methods = state?.mfa_methods ?? []
  const hasPasskey = methods.includes('passkey')
  const hasTOTP = methods.includes('totp')
  const hasRecovery = methods.includes('recovery_code') && (state?.recovery_codes_remaining ?? 0) > 0
  const passkeyUsable = hasPasskey && (support?.supported ?? false)
  const noUsableMethod = state !== null && !passkeyUsable && !hasTOTP && !hasRecovery
  const passkeyWarning =
    state !== null && passkeyUsable && !hasTOTP && !hasRecovery && state.recovery_codes_remaining === 0

  const restart = useCallback(async () => {
    if (busy === 'leave') return
    setBusy('leave')
    setInlineError('')
    try {
      await signOutAndRestart()
    } catch {
      navigateTo('/login')
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }, [busy])

  /** Shared 401/403/429/network handling; returns true when the page changed. */
  const handleFatalError = useCallback((err: unknown, missingCopy: string): boolean => {
    const serverCode = mfaErrorCode(err)
    const status = mfaErrorStatus(err)
    if (status === 401 || serverCode === 'mfa_no_pending') {
      setNotice(mfaServerErrorCopy(serverCode) ?? '')
      setPhase('expired')
      return true
    }
    if (status === 403) {
      setNotice(errorMessage(err))
      setPhase('disabled')
      return true
    }
    if (status === 429 || serverCode === 'mfa_locked') {
      const seconds = mfaRetryAfterSeconds(err)
      if (seconds) {
        setLockoutSeconds(seconds)
        return true
      }
      setInlineError(mfaCopy.verify.rateLimited)
      return true
    }
    setInlineError(mfaServerErrorCopy(serverCode) ?? errorMessage(err) ?? missingCopy)
    return true
  }, [])

  const handleTOTP = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy !== null || code.length !== 6) return
    setBusy('totp')
    setInlineError('')
    setHint('')
    try {
      await verifyTOTP(code, { navigate: false })
      if (aliveRef.current) setSuccess(true)
    } catch (err) {
      if (!aliveRef.current) return
      const serverCode = mfaErrorCode(err)
      if (mfaErrorStatus(err) === 400 || serverCode === 'mfa_invalid' || serverCode === 'mfa_passkey_failed') {
        setInlineError(mfaCopy.verify.invalidCode)
        setCode('')
        return
      }
      handleFatalError(err, mfaCopy.verify.invalidCode)
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }

  const handleRecovery = async (event: React.FormEvent) => {
    event.preventDefault()
    const normalized = normalizeRecoveryCode(recoveryCode)
    if (busy !== null || normalized.length < 8) return
    setBusy('recovery')
    setInlineError('')
    setHint('')
    try {
      await verifyRecoveryCode(normalized, { navigate: false })
      if (aliveRef.current) setSuccess(true)
    } catch (err) {
      if (!aliveRef.current) return
      const serverCode = mfaErrorCode(err)
      if (mfaErrorStatus(err) === 400 || serverCode === 'mfa_invalid') {
        setInlineError(mfaCopy.verify.invalidRecoveryCode)
        setRecoveryCode('')
        return
      }
      handleFatalError(err, mfaCopy.verify.invalidRecoveryCode)
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }

  const handlePasskey = async () => {
    if (busy !== null) return
    setBusy('passkey')
    setInlineError('')
    setHint('')
    try {
      const begin = await beginPasskeyLogin()
      await completePasskeyLogin(begin.challengeId, { navigate: false })
      if (aliveRef.current) setSuccess(true)
    } catch (err) {
      if (!aliveRef.current) return
      const serverCode = mfaErrorCode(err)
      const status = mfaErrorStatus(err)
      if (status === 401 || status === 403 || status === 429 || serverCode === 'mfa_locked' || serverCode === 'mfa_no_pending') {
        handleFatalError(err, mfaCopy.verify.passkeyFailed)
        return
      }
      if (isWebAuthnCancel(err)) {
        if (webAuthnErrorKey(err) === 'ceremony_aborted') return
        setHint(mfaCopy.verify.passkeyCancelled)
        return
      }
      const webauthnCopy = webAuthnErrorMessage(err)
      if (webauthnCopy) {
        setHint(webauthnCopy)
        return
      }
      setHint(mfaServerErrorCopy(serverCode) ?? mfaCopy.verify.passkeyFailed)
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }

  const handleLockoutUnlock = () => {
    setLockoutSeconds(null)
    setBusy(null)
    setInlineError('')
  }

  const switchToRecovery = () => {
    setMode('recovery')
    setInlineError('')
    setHint('')
  }

  const switchToMethods = () => {
    setMode('totp')
    setInlineError('')
    setRecoveryCode('')
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#04060c] flex items-center justify-center px-4 py-10">
      <HoloPageBackground />

      <div className="relative z-10 w-full max-w-md">
        <div className="relative bg-[#080d16]/80 backdrop-blur-md border border-teal-500/25 rounded-xl p-8 shadow-[0_0_60px_-18px_rgba(45,212,191,0.55)]">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-10 -top-px h-px bg-gradient-to-r from-transparent via-teal-300/70 to-transparent"
          />
          <div className="flex flex-col items-center text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-teal-500/10 ring-1 ring-teal-400/30 mb-4 shadow-[0_0_24px_-6px_rgba(45,212,191,0.65)]">
              <IconShieldLock size={24} stroke={1.6} className="text-teal-300" aria-hidden="true" />
            </span>
            <h1 className="text-xl font-semibold tracking-tight text-zinc-50">
              {phase === 'expired'
                ? mfaCopy.verify.expiredTitle
                : phase === 'disabled'
                  ? mfaCopy.verify.disabledTitle
                  : mfaCopy.verify.title}
            </h1>
            {phase === 'choose' && (
              <p className="mt-2 text-sm text-zinc-400">
                {mode === 'recovery' ? mfaCopy.verify.subtitleRecovery : mfaCopy.verify.subtitle}
              </p>
            )}
            {(phase === 'expired' || phase === 'disabled') && (
              <p className="mt-2 text-sm text-zinc-400">
                {phase === 'expired'
                  ? mfaCopy.verify.expiredBody
                  : notice || mfaCopy.verify.disabledBody}
              </p>
            )}
          </div>

          {phase === 'loading' && (
            <div className="mt-8 flex flex-col items-center gap-4 text-sm text-zinc-400" data-testid="mfa-verify-loading">
              <span
                aria-hidden="true"
                className="h-8 w-8 rounded-full border-2 border-teal-400/30 border-t-teal-300 animate-spin motion-reduce:animate-none"
              />
              {mfaCopy.verify.loading}
            </div>
          )}

          {(phase === 'expired' || phase === 'disabled') && (
            <div className="mt-8 space-y-3">
              <PrimaryButton onClick={() => void restart()} disabled={busy === 'leave'} className="w-full py-2.5">
                {busy === 'leave' ? 'Leaving…' : mfaCopy.common.signInAgain}
              </PrimaryButton>
              <GhostButton onClick={() => void restart()} disabled={busy === 'leave'} className="w-full">
                {mfaCopy.common.signOutAndRestart}
              </GhostButton>
            </div>
          )}

          {phase === 'choose' && (
            <div className="mt-8">
              {notice && <p className="text-amber-400/90 text-sm mb-4">{notice}</p>}

              {noUsableMethod ? (
                <div className="space-y-4">
                  <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-300">
                    <IconAlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{mfaCopy.verify.passkeyBlocked}</span>
                  </div>
                  <PrimaryButton onClick={() => void restart()} disabled={busy === 'leave'} className="w-full py-2.5">
                    {mfaCopy.common.signInAgain}
                  </PrimaryButton>
                </div>
              ) : (
                <>
                  {hasPasskey && (
                    <div className="mb-6 space-y-2">
                      <PrimaryButton
                        type="button"
                        onClick={() => void handlePasskey()}
                        disabled={busy !== null || !passkeyUsable}
                        className="w-full py-2.5"
                      >
                        {busy === 'passkey' ? mfaCopy.verify.passkeyBusy : mfaCopy.verify.passkeyButton}
                      </PrimaryButton>
                      {!passkeyUsable && (
                        <p className="text-xs text-amber-400/90">
                          {support ? webAuthnUnavailableMessage(support) : mfaCopy.verify.passkeyUnsupported}
                        </p>
                      )}
                      {hasTOTP && (
                        <p className="text-center text-xs uppercase tracking-[0.2em] text-zinc-600">
                          {mfaCopy.verify.passkeyDivider}
                        </p>
                      )}
                    </div>
                  )}

                  {passkeyWarning && (
                    <div className="mb-5 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-xs text-amber-300">
                      <IconAlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>
                        This account has no authenticator app and no recovery codes. If you lose this
                        passkey you will need a super admin to reset your MFA.
                      </span>
                    </div>
                  )}

                  {hint && (
                    <div
                      role="status"
                      className="mb-5 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-300"
                    >
                      <IconAlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>{hint}</span>
                    </div>
                  )}

                  {mode === 'recovery' ? (
                    <form onSubmit={(event) => void handleRecovery(event)}>
                      <div className="mb-4">
                        <label htmlFor="mfa-recovery-code" className={labelCls}>
                          {mfaCopy.verify.recoveryLabel}
                        </label>
                        <input
                          id="mfa-recovery-code"
                          type="text"
                          autoFocus
                          autoComplete="one-time-code"
                          spellCheck={false}
                          maxLength={20}
                          className={`${inputCls} text-center font-mono text-lg tracking-widest`}
                          placeholder={mfaCopy.verify.recoveryPlaceholder}
                          value={recoveryCode}
                          disabled={busy !== null}
                          onChange={(e) => setRecoveryCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
                        />
                        <p className="text-xs text-zinc-600 mt-1">{mfaCopy.verify.recoveryHelp}</p>
                      </div>

                      {inlineError && <div role="alert" className="text-red-400 text-sm mb-4">{inlineError}</div>}

                      <PrimaryButton
                        type="submit"
                        disabled={busy !== null || normalizeRecoveryCode(recoveryCode).length < 8}
                        className="w-full"
                      >
                        {busy === 'recovery' ? mfaCopy.verify.verifyingButton : mfaCopy.verify.recoverySubmit}
                      </PrimaryButton>
                      <GhostButton type="button" onClick={switchToMethods} disabled={busy !== null} className="w-full mt-3">
                        {mfaCopy.verify.useOtherMethods}
                      </GhostButton>
                    </form>
                  ) : (
                    <>
                      {hasTOTP && (
                        <form onSubmit={(event) => void handleTOTP(event)}>
                          <div className="mb-2">
                            <label htmlFor="mfa-totp-code" className={labelCls}>
                              {mfaCopy.verify.totpLabel}
                            </label>
                            <input
                              id="mfa-totp-code"
                              type="text"
                              inputMode="numeric"
                              autoComplete="one-time-code"
                              autoFocus={!passkeyUsable}
                              maxLength={6}
                              className={`${inputCls} text-center text-2xl tracking-widest font-mono`}
                              placeholder={mfaCopy.verify.totpPlaceholder}
                              value={code}
                              disabled={busy !== null}
                              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                            />
                            <p className="text-xs text-zinc-600 mt-1">{mfaCopy.verify.totpHelp}</p>
                          </div>

                          {inlineError && <div role="alert" className="text-red-400 text-sm mt-3">{inlineError}</div>}

                          <PrimaryButton
                            type="submit"
                            disabled={busy !== null || code.length !== 6}
                            className="w-full mt-4"
                          >
                            {busy === 'totp' ? mfaCopy.verify.verifyingButton : mfaCopy.verify.verifyButton}
                          </PrimaryButton>
                        </form>
                      )}

                      {hasRecovery && (
                        <button
                          type="button"
                          onClick={switchToRecovery}
                          disabled={busy !== null}
                          className="mt-4 w-full text-center text-sm text-teal-300/90 hover:text-teal-200 disabled:opacity-50"
                        >
                          {mfaCopy.verify.useRecovery}
                        </button>
                      )}

                      {inlineError && !hasTOTP && (
                        <div role="alert" className="text-red-400 text-sm mt-3">{inlineError}</div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {phase !== 'loading' && (
          <div className="mt-6 space-y-2 text-center text-xs text-zinc-600">
            <button
              type="button"
              onClick={() => void restart()}
              disabled={busy === 'leave'}
              className="text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
            >
              {mfaCopy.common.signOutAndRestart}
            </button>
            <p className="flex items-center justify-center gap-1.5">
              <IconFingerprint size={13} aria-hidden="true" />
              {mfaCopy.verify.footerHelp}
            </p>
          </div>
        )}
      </div>

      {lockoutSeconds !== null && (
        <LoginLockoutOverlay seconds={lockoutSeconds} onUnlock={handleLockoutUnlock} />
      )}

      {success && (
        <AuthStatusOverlay
          status="success"
          durationMs={successOverlayMs}
          onDone={() => navigateTo('/dashboard')}
        />
      )}
    </div>
  )
}

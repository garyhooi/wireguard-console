import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCheck,
  IconCopy,
  IconDownload,
  IconFingerprint,
  IconKey,
  IconShieldLock,
} from '@tabler/icons-react'
import { AuthStatusOverlay } from '../components/AuthStatusOverlay'
import { HoloPageBackground } from '../components/HoloPageBackground'
import { GhostButton, PrimaryButton, inputCls, labelCls } from '../lib/ui'
import {
  beginPasskeyEnrollment,
  beginTOTPEnrollment,
  completeEnrollment,
  completePasskeyEnrollment,
  finishTOTPEnrollment,
  getMFAState,
  getMFAStatus,
  mfaErrorCode,
  mfaErrorStatus,
  navigateTo,
  signOutAndRestart,
  type MFAState,
  type MFAStatus,
  type TOTPEnrollment,
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
 * /mfa-setup — multi-factor enrollment.
 *
 * The forced flow (?forced=1) runs on the pending cookie issued by /login
 * when an admin has zero factors: add factors -> POST enroll/complete (which
 * mints the session and returns one-time recovery codes) -> show the codes
 * once behind an acknowledgement -> success overlay -> /dashboard.
 *
 * Without ?forced=1 the route is a graceful landing for signed-in users; the
 * actual factor management UI lives in Profile (frontend-manage).
 */

type ForcedPhase = 'loading' | 'expired' | 'choose' | 'totp' | 'passkey' | 'review' | 'recovery'
type AuthedPhase = 'idle' | 'authed' | 'needs-login'

type BusyKind = 'begin-totp' | 'finish-totp' | 'passkey' | 'complete' | 'leave' | null

interface Selection {
  totp: boolean
  passkey: boolean
}

function forcedFromLocation(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('forced') === '1'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : ''
}

export const Route = createFileRoute('/mfa-setup')({
  component: MFASetupPage,
})

export function MFASetupPage({ successOverlayMs = 2000 }: { successOverlayMs?: number } = {}) {
  const [forced] = useState<boolean>(() => forcedFromLocation())

  // Forced enrollment state.
  const [phase, setPhase] = useState<ForcedPhase>('loading')
  const [state, setState] = useState<MFAState | null>(null)
  const [support, setSupport] = useState<WebAuthnSupport | null>(null)
  const [selected, setSelected] = useState<Selection>({ totp: false, passkey: false })
  const [added, setAdded] = useState<Selection>({ totp: false, passkey: false })
  const [totpData, setTotpData] = useState<TOTPEnrollment | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [code, setCode] = useState('')
  const [inlineError, setInlineError] = useState('')
  const [hint, setHint] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<BusyKind>(null)
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [missingMethods, setMissingMethods] = useState<string[]>([])
  const [acknowledged, setAcknowledged] = useState(false)
  const [copied, setCopied] = useState(false)
  const [success, setSuccess] = useState(false)
  const aliveRef = useRef(true)

  // Authed (non-forced) landing state.
  const [authedPhase, setAuthedPhase] = useState<AuthedPhase>('idle')
  const [mfaStatus, setMfaStatus] = useState<MFAStatus | null>(null)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      void cancelCeremony()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!forced) {
      void getMFAStatus()
        .then((status) => {
          if (cancelled) return
          setMfaStatus(status)
          setAuthedPhase('authed')
        })
        .catch(() => {
          if (!cancelled) setAuthedPhase('needs-login')
        })
      return () => {
        cancelled = true
      }
    }

    void (async () => {
      try {
        const [nextState, nextSupport] = await Promise.all([getMFAState(), detectWebAuthnSupport()])
        if (cancelled) return
        if (nextState.pending_kind !== 'enroll') {
          // A verify challenge on the setup URL: send the user back to sign in.
          setPhase('expired')
          return
        }
        setState(nextState)
        setSupport(nextSupport)
        // setup_methods lists the methods this deployment can offer; the
        // require_methods policy says which of them are mandatory.
        const policy = nextState.require_methods
        setSelected({
          totp: policy === 'totp' || policy === 'both',
          passkey: policy === 'passkey' || policy === 'both',
        })
        setPhase('choose')
      } catch (err) {
        if (cancelled) return
        if (mfaErrorStatus(err) === 403) setNotice(errorMessage(err))
        setPhase('expired')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [forced])

  // setup_methods = methods this deployment can offer; require_methods = the
  // organisation policy that decides which are mandatory.
  const offered = state?.setup_methods ?? []
  const policy = state?.require_methods ?? 'any'
  // An empty list means "no deployment restriction" (offer the standard
  // methods); the backend normally lists the usable ones explicitly.
  const totpOffered = offered.length === 0 || offered.includes('totp')
  const passkeyOffered = offered.length === 0 || offered.includes('passkey')
  const totpRequired = policy === 'totp' || policy === 'both'
  const passkeyRequired = policy === 'passkey' || policy === 'both'
  const passkeyUsable =
    passkeyOffered && (state?.passkey_available ?? false) && (support?.supported ?? false)
  const passkeyBlocked = passkeyRequired && !passkeyUsable
  const hasSelection = selected.totp || selected.passkey || totpRequired || passkeyRequired
  const requiredSatisfied =
    (!totpRequired || selected.totp || added.totp) &&
    (!passkeyRequired || selected.passkey || added.passkey)
  const canContinue = !passkeyBlocked && hasSelection && requiredSatisfied && !(added.totp && added.passkey)
  const requiredBanner =
    state?.require_methods === 'both'
      ? mfaCopy.setup.requiredBoth
      : state?.require_methods === 'totp'
        ? mfaCopy.setup.requiredTotp
        : state?.require_methods === 'passkey'
          ? mfaCopy.setup.requiredPasskey
          : ''

  /** 401/403 during a pending-cookie call: the enrollment session is gone. */
  const failPending = useCallback((err: unknown): boolean => {
    const status = mfaErrorStatus(err)
    const serverCode = mfaErrorCode(err)
    if (status === 401 || status === 403 || serverCode === 'mfa_no_pending') {
      if (status === 403) setNotice(errorMessage(err))
      setPhase('expired')
      return true
    }
    return false
  }, [])

  const restart = useCallback(async () => {
    if (busy === 'leave') return
    setBusy('leave')
    try {
      await signOutAndRestart()
    } catch {
      navigateTo('/login')
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }, [busy])

  const startTOTP = useCallback(async () => {
    if (totpData) {
      // Re-entering the TOTP step (e.g. after visiting the passkey step):
      // reuse the pending secret instead of burning a new one.
      setPhase('totp')
      return
    }
    setBusy('begin-totp')
    setInlineError('')
    setHint('')
    try {
      const data = await beginTOTPEnrollment()
      const url = await QRCode.toDataURL(data.otpauth_url, { width: 320, margin: 1 }).catch(() => '')
      if (!aliveRef.current) return
      setTotpData(data)
      setQrDataUrl(url)
    } catch (err) {
      if (!aliveRef.current) return
      if (failPending(err)) return
      if (mfaErrorCode(err) === 'mfa_already_enabled') {
        setNotice(mfaCopy.setup.totpAlreadyEnabled)
        setAdded((current) => ({ ...current, totp: true }))
        setPhase('choose')
        return
      }
      setInlineError(mfaServerErrorCopy(mfaErrorCode(err)) ?? errorMessage(err) ?? mfaCopy.setup.totpInvalid)
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }, [failPending, totpData])

  const advanceToNext = useCallback(
    (nextAdded: Selection) => {
      if (selected.totp && !nextAdded.totp) {
        setPhase('totp')
        void startTOTP()
        return
      }
      if (selected.passkey && !nextAdded.passkey) {
        setPhase('passkey')
        return
      }
      setPhase('review')
    },
    [selected, startTOTP],
  )

  const toggleFactor = (factor: 'totp' | 'passkey') => {
    if (factor === 'totp' && totpRequired) return
    if (factor === 'passkey' && (passkeyRequired || !passkeyUsable)) return
    setSelected((current) => ({ ...current, [factor]: !current[factor] }))
  }

  const continueSetup = () => {
    if (!canContinue || busy !== null) return
    if (selected.totp && !added.totp) {
      setPhase('totp')
      void startTOTP()
      return
    }
    if (selected.passkey && !added.passkey) {
      setPhase('passkey')
      return
    }
    setPhase('review')
  }

  const finishTOTP = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy !== null || code.length !== 6) return
    setBusy('finish-totp')
    setInlineError('')
    try {
      await finishTOTPEnrollment(code)
      if (!aliveRef.current) return
      const next = { ...added, totp: true }
      setAdded(next)
      setNotice(mfaCopy.setup.totpAdded)
      advanceToNext(next)
    } catch (err) {
      if (!aliveRef.current) return
      if (failPending(err)) return
      if (mfaErrorStatus(err) === 400 || mfaErrorCode(err) === 'mfa_invalid') {
        setInlineError(mfaCopy.setup.totpInvalid)
        setCode('')
        return
      }
      setInlineError(mfaServerErrorCopy(mfaErrorCode(err)) ?? errorMessage(err) ?? mfaCopy.setup.totpInvalid)
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }

  const startPasskey = async () => {
    if (busy !== null) return
    setBusy('passkey')
    setInlineError('')
    setHint('')
    try {
      const begin = await beginPasskeyEnrollment()
      await completePasskeyEnrollment(begin.challengeId)
      if (!aliveRef.current) return
      const next = { ...added, passkey: true }
      setAdded(next)
      setNotice(mfaCopy.setup.passkeyAdded)
      advanceToNext(next)
    } catch (err) {
      if (!aliveRef.current) return
      if (failPending(err)) return
      if (isWebAuthnCancel(err)) {
        if (webAuthnErrorKey(err) === 'ceremony_aborted') return
        setHint(mfaCopy.setup.passkeyCancelled)
        return
      }
      const passkeyCopy = webAuthnErrorMessage(err)
      if (passkeyCopy) {
        setHint(passkeyCopy)
        return
      }
      setInlineError(mfaServerErrorCopy(mfaErrorCode(err)) ?? errorMessage(err) ?? mfaCopy.setup.passkeyFailed)
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }

  const completeSetup = async () => {
    if (busy !== null) return
    setBusy('complete')
    setInlineError('')
    try {
      const data = await completeEnrollment()
      if (!aliveRef.current) return
      setRecoveryCodes(data.recovery_codes ?? [])
      setPhase('recovery')
    } catch (err) {
      if (!aliveRef.current) return
      if (failPending(err)) return
      const serverCode = mfaErrorCode(err)
      if (serverCode === 'mfa_policy_violation') {
        const body = (err as { body?: unknown }).body
        const rawMissing = (body as { missing_methods?: unknown } | undefined)?.missing_methods
        const missing = Array.isArray(rawMissing)
          ? rawMissing.filter((method): method is string => typeof method === 'string')
          : []
        setMissingMethods(missing)
        setSelected((current) => ({
          totp: current.totp || missing.includes('totp'),
          passkey: current.passkey || missing.includes('passkey'),
        }))
        setNotice(mfaCopy.setup.policyViolation)
        setPhase('choose')
        return
      }
      setInlineError(mfaServerErrorCopy(serverCode) ?? errorMessage(err) ?? mfaCopy.setup.policyViolation)
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }

  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'))
      setCopied(true)
    } catch {
      // Clipboard unavailable (insecure context / permission denied).
    }
  }

  const downloadCodes = () => {
    try {
      const blob = new Blob(
        [
          'WireGuard Console — recovery codes\n',
          'Each code can be used once. Keep this file somewhere safe and offline.\n\n',
          recoveryCodes.join('\n'),
          '\n',
        ],
        { type: 'text/plain' },
      )
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'wireguard-console-recovery-codes.txt'
      link.click()
      URL.revokeObjectURL(url)
    } catch {
      // Download unsupported in this browser.
    }
  }

  const dismissRecovery = () => {
    setSuccess(true)
  }

  const heading =
    phase === 'expired'
      ? mfaCopy.setup.expiredTitle
      : phase === 'recovery'
        ? mfaCopy.setup.recoveryTitle
        : phase === 'review'
          ? mfaCopy.setup.reviewTitle
          : phase === 'totp'
            ? mfaCopy.setup.totpTitle
            : phase === 'passkey'
              ? mfaCopy.setup.passkeyTitle
              : phase === 'choose'
                ? mfaCopy.setup.chooseTitle
                : mfaCopy.setup.title

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#04060c] flex items-center justify-center px-4 py-10">
      <HoloPageBackground />

      <div className="relative z-10 w-full max-w-lg">
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
              {!forced
                ? authedPhase === 'authed'
                  ? mfaCopy.setup.authedTitle
                  : authedPhase === 'idle'
                    ? mfaCopy.setup.title
                    : mfaCopy.setup.needsSignInTitle
                : heading}
            </h1>
            {forced && phase === 'choose' && (
              <p className="mt-2 text-sm text-zinc-400">{mfaCopy.setup.chooseSubtitle}</p>
            )}
            {forced && phase === 'review' && (
              <p className="mt-2 text-sm text-zinc-400">{mfaCopy.setup.reviewSubtitle}</p>
            )}
            {forced && phase === 'recovery' && (
              <p className="mt-2 text-sm text-zinc-400">{mfaCopy.setup.recoverySubtitle}</p>
            )}
            {forced && phase === 'expired' && (
              <p className="mt-2 text-sm text-zinc-400">{notice || mfaCopy.setup.expiredBody}</p>
            )}
            {!forced && authedPhase === 'authed' && (
              <p className="mt-2 text-sm text-zinc-400">{mfaCopy.setup.authedSubtitle}</p>
            )}
            {!forced && authedPhase === 'needs-login' && (
              <p className="mt-2 text-sm text-zinc-400">{mfaCopy.setup.needsSignInBody}</p>
            )}
          </div>

          {/* --- authed (non-forced) graceful states ----------------------- */}
          {!forced && (authedPhase === 'idle' || authedPhase === 'needs-login') && (
            <div className="mt-8 flex flex-col items-center gap-4 text-sm text-zinc-400">
              {authedPhase === 'idle' && (
                <>
                  <span
                    aria-hidden="true"
                    className="h-8 w-8 rounded-full border-2 border-teal-400/30 border-t-teal-300 animate-spin motion-reduce:animate-none"
                  />
                  {mfaCopy.setup.loading}
                </>
              )}
              {authedPhase === 'needs-login' && (
                <PrimaryButton onClick={() => navigateTo('/login')} className="w-full py-2.5">
                  {mfaCopy.common.signInAgain}
                </PrimaryButton>
              )}
            </div>
          )}

          {!forced && authedPhase === 'authed' && (
            <div className="mt-8 space-y-5">
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-300">
                <p className="font-medium text-zinc-100">
                  {mfaStatus?.mfa_enabled ? 'MFA is enabled' : 'MFA is not set up yet'}
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  {mfaStatus
                    ? `${mfaStatus.factors.length} factor(s) · ${mfaStatus.recovery_codes_remaining} recovery code(s) remaining`
                    : ''}
                </p>
              </div>
              <a
                href="/profile"
                className="block w-full rounded-lg bg-teal-500 px-4 py-2.5 text-center text-sm font-medium text-zinc-950 hover:bg-teal-400"
              >
                {mfaCopy.setup.authedGoToProfile}
              </a>
            </div>
          )}

          {/* --- forced enrollment ---------------------------------------- */}
          {forced && phase === 'loading' && (
            <div className="mt-8 flex flex-col items-center gap-4 text-sm text-zinc-400" data-testid="mfa-setup-loading">
              <span
                aria-hidden="true"
                className="h-8 w-8 rounded-full border-2 border-teal-400/30 border-t-teal-300 animate-spin motion-reduce:animate-none"
              />
              {mfaCopy.setup.loading}
            </div>
          )}

          {forced && phase === 'expired' && (
            <div className="mt-8 space-y-3">
              <PrimaryButton onClick={() => void restart()} disabled={busy === 'leave'} className="w-full py-2.5">
                {busy === 'leave' ? 'Leaving…' : mfaCopy.common.signInAgain}
              </PrimaryButton>
              <GhostButton onClick={() => void restart()} disabled={busy === 'leave'} className="w-full">
                {mfaCopy.common.signOutAndRestart}
              </GhostButton>
            </div>
          )}

          {forced && phase === 'choose' && (
            <div className="mt-6 space-y-4">
              <p className="text-sm leading-relaxed text-zinc-400">{mfaCopy.setup.forcedIntro}</p>
              {requiredBanner && (
                <div className="rounded-lg border border-teal-500/25 bg-teal-500/5 p-3 text-xs text-teal-200">
                  {requiredBanner}
                </div>
              )}
              {missingMethods.length > 0 && (
                <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-300">
                  <IconAlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>
                    {mfaCopy.setup.policyViolation} {mfaCopy.setup.missingMethodsLabel}{' '}
                    {missingMethods.map(methodLabel).join(', ')}
                  </span>
                </div>
              )}
              {notice && <p className="text-xs text-teal-300">{notice}</p>}

              <div className="space-y-3">
                <button
                  type="button"
                  aria-pressed={selected.passkey}
                  disabled={!passkeyUsable || passkeyRequired || added.passkey}
                  onClick={() => toggleFactor('passkey')}
                  className={
                    'w-full rounded-lg border p-4 text-left transition disabled:opacity-60 ' +
                    (selected.passkey
                      ? 'border-teal-400/60 bg-teal-500/10'
                      : 'border-zinc-700 bg-zinc-900/40 hover:border-zinc-500')
                  }
                >
                  <span className="flex items-start gap-3">
                    <IconFingerprint size={22} className="mt-0.5 shrink-0 text-teal-300" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 font-medium text-zinc-100">
                        {mfaCopy.setup.passkeyCardTitle}
                        <span className="rounded-full border border-teal-400/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-teal-300">
                          {mfaCopy.setup.passkeyCardBadge}
                        </span>
                        {passkeyRequired && (
                          <span className="text-[10px] uppercase tracking-wide text-amber-400">
                            {mfaCopy.setup.requiredByPolicy}
                          </span>
                        )}
                      </span>
                      <span className="mt-1 block text-xs text-zinc-400">{mfaCopy.setup.passkeyCardBody}</span>
                      {!passkeyUsable && (
                        <span className="mt-2 block text-xs text-amber-400/90">
                          {state && !state.passkey_available
                            ? state.passkey_reason || mfaCopy.setup.passkeyUnavailable
                            : support
                              ? webAuthnUnavailableMessage(support)
                              : mfaCopy.setup.passkeyUnsupported}
                        </span>
                      )}
                      {added.passkey && (
                        <span className="mt-2 flex items-center gap-1 text-xs text-teal-300">
                          <IconCheck size={14} aria-hidden="true" /> {mfaCopy.setup.passkeyAdded}
                        </span>
                      )}
                    </span>
                  </span>
                </button>

                <button
                  type="button"
                  aria-pressed={selected.totp}
                  disabled={totpRequired || !totpOffered || added.totp}
                  onClick={() => toggleFactor('totp')}
                  className={
                    'w-full rounded-lg border p-4 text-left transition disabled:opacity-60 ' +
                    (selected.totp
                      ? 'border-teal-400/60 bg-teal-500/10'
                      : 'border-zinc-700 bg-zinc-900/40 hover:border-zinc-500')
                  }
                >
                  <span className="flex items-start gap-3">
                    <IconKey size={22} className="mt-0.5 shrink-0 text-teal-300" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 font-medium text-zinc-100">
                        {mfaCopy.setup.totpCardTitle}
                        {totpRequired && (
                          <span className="text-[10px] uppercase tracking-wide text-amber-400">
                            {mfaCopy.setup.requiredByPolicy}
                          </span>
                        )}
                      </span>
                      <span className="mt-1 block text-xs text-zinc-400">{mfaCopy.setup.totpCardBody}</span>
                      {added.totp && (
                        <span className="mt-2 flex items-center gap-1 text-xs text-teal-300">
                          <IconCheck size={14} aria-hidden="true" /> {mfaCopy.setup.totpAlreadyEnabled}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </div>

              {passkeyBlocked && (
                <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-300">
                  <IconAlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{mfaCopy.setup.passkeyUnsupported}</span>
                </div>
              )}

              {!hasSelection && <p className="text-xs text-amber-400/90">{mfaCopy.setup.chooseHint}</p>}
              {inlineError && <p className="text-sm text-red-400">{inlineError}</p>}

              <PrimaryButton
                type="button"
                onClick={continueSetup}
                disabled={!canContinue || busy !== null}
                className="w-full py-2.5"
              >
                {mfaCopy.setup.continueButton}
              </PrimaryButton>
            </div>
          )}

          {forced && phase === 'totp' && (
            <div className="mt-6 space-y-4">
              <p className="text-sm text-zinc-400">{mfaCopy.setup.totpSubtitle}</p>

              {busy === 'begin-totp' && <p className="text-sm text-zinc-400">Generating your setup key…</p>}
              {!totpData && busy !== 'begin-totp' && (
                <PrimaryButton
                  type="button"
                  onClick={() => void startTOTP()}
                  disabled={busy !== null}
                  className="w-full"
                >
                  {mfaCopy.common.tryAgain}
                </PrimaryButton>
              )}

              {totpData && (
                <>
                  <div className="flex justify-center">
                    <div className="rounded-lg bg-white p-4">
                      {qrDataUrl ? (
                        <img src={qrDataUrl} alt="Authenticator setup QR code" className="h-44 w-44" />
                      ) : (
                        <div className="flex h-44 w-44 items-center justify-center text-sm text-zinc-500">
                          Generating…
                        </div>
                      )}
                    </div>
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-wide text-zinc-500">{mfaCopy.setup.totpManualKey}</p>
                    <code className="mt-1 block break-all rounded bg-zinc-900 px-3 py-2 font-mono text-sm text-teal-300">
                      {totpData.secret}
                    </code>
                  </div>

                  <form onSubmit={(event) => void finishTOTP(event)}>
                    <label htmlFor="mfa-setup-code" className={labelCls}>
                      {mfaCopy.setup.totpCodeLabel}
                    </label>
                    <input
                      id="mfa-setup-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      className={`${inputCls} text-center text-2xl font-mono tracking-widest`}
                      placeholder="000000"
                      value={code}
                      disabled={busy !== null}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    />
                    {inlineError && <p role="alert" className="mt-3 text-sm text-red-400">{inlineError}</p>}
                    <PrimaryButton
                      type="submit"
                      disabled={busy !== null || code.length !== 6}
                      className="mt-4 w-full"
                    >
                      {busy === 'finish-totp' ? mfaCopy.setup.totpVerifyingButton : mfaCopy.setup.totpVerifyButton}
                    </PrimaryButton>
                  </form>
                </>
              )}

              <GhostButton
                type="button"
                onClick={() => {
                  setPhase('choose')
                  setInlineError('')
                }}
                disabled={busy !== null}
                className="w-full"
              >
                <IconArrowLeft size={15} aria-hidden="true" /> {mfaCopy.common.back}
              </GhostButton>
            </div>
          )}

          {forced && phase === 'passkey' && (
            <div className="mt-6 space-y-4">
              <div className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
                <IconFingerprint size={20} className="mt-0.5 shrink-0 text-teal-300" aria-hidden="true" />
                <span>{mfaCopy.setup.passkeySubtitle}</span>
              </div>

              {hint && (
                <div role="status" className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-300">
                  <IconAlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{hint}</span>
                </div>
              )}
              {inlineError && <p role="alert" className="text-sm text-red-400">{inlineError}</p>}

              <PrimaryButton
                type="button"
                onClick={() => void startPasskey()}
                disabled={busy !== null || !passkeyUsable}
                className="w-full py-2.5"
              >
                {busy === 'passkey' ? mfaCopy.setup.passkeyCreatingButton : mfaCopy.setup.passkeyCreateButton}
              </PrimaryButton>

              {!passkeyUsable && (
                <p className="text-xs text-amber-400/90">
                  {state && !state.passkey_available
                    ? state.passkey_reason || mfaCopy.setup.passkeyUnavailable
                    : support
                      ? webAuthnUnavailableMessage(support)
                      : mfaCopy.setup.passkeyNotSupportedThisBrowser}
                </p>
              )}

              <GhostButton
                type="button"
                onClick={() => {
                  setPhase('choose')
                  setInlineError('')
                  setHint('')
                }}
                disabled={busy !== null}
                className="w-full"
              >
                <IconArrowLeft size={15} aria-hidden="true" /> {mfaCopy.common.back}
              </GhostButton>
            </div>
          )}

          {forced && phase === 'review' && (
            <div className="mt-6 space-y-4">
              {notice && <p className="text-xs text-teal-300">{notice}</p>}
              <div className="space-y-2">
                <FactorRow label={mfaCopy.setup.reviewTotp} added={added.totp} />
                <FactorRow label={mfaCopy.setup.reviewPasskey} added={added.passkey} />
              </div>
              {inlineError && <p role="alert" className="text-sm text-red-400">{inlineError}</p>}
              <PrimaryButton
                type="button"
                onClick={() => void completeSetup()}
                disabled={busy !== null || !(added.totp || added.passkey)}
                className="w-full py-2.5"
              >
                {busy === 'complete' ? mfaCopy.setup.completingButton : mfaCopy.setup.completeButton}
              </PrimaryButton>
              <GhostButton
                type="button"
                onClick={() => setPhase('choose')}
                disabled={busy !== null}
                className="w-full"
              >
                <IconArrowLeft size={15} aria-hidden="true" /> {mfaCopy.common.back}
              </GhostButton>
            </div>
          )}

          {forced && phase === 'recovery' && (
            <div className="mt-6 space-y-4">
              {recoveryCodes.length > 0 ? (
                <>
                  <div className="grid grid-cols-2 gap-2 rounded-lg bg-zinc-900 p-4">
                    {recoveryCodes.map((recoveryCode) => (
                      <code key={recoveryCode} className="font-mono text-sm text-zinc-200">
                        {recoveryCode}
                      </code>
                    ))}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <GhostButton type="button" onClick={() => void copyCodes()} className="flex-1">
                      <IconCopy size={15} aria-hidden="true" />
                      {copied ? mfaCopy.setup.recoveryCopied : mfaCopy.setup.recoveryCopyAll}
                    </GhostButton>
                    <GhostButton type="button" onClick={downloadCodes} className="flex-1">
                      <IconDownload size={15} aria-hidden="true" />
                      {mfaCopy.setup.recoveryDownload}
                    </GhostButton>
                  </div>

                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-sm text-zinc-300">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-teal-500"
                      checked={acknowledged}
                      onChange={(e) => setAcknowledged(e.target.checked)}
                    />
                    {mfaCopy.setup.recoveryAck}
                  </label>
                </>
              ) : (
                <p className="text-sm text-zinc-400">{mfaCopy.setup.recoveryMissing}</p>
              )}

              <PrimaryButton
                type="button"
                onClick={dismissRecovery}
                disabled={recoveryCodes.length > 0 && !acknowledged}
                className="w-full py-2.5"
              >
                {mfaCopy.setup.recoveryContinue}
              </PrimaryButton>
            </div>
          )}
        </div>

        {forced && phase !== 'loading' && phase !== 'expired' && (
          <div className="mt-6 text-center text-xs text-zinc-600">
            <button
              type="button"
              onClick={() => void restart()}
              disabled={busy === 'leave'}
              className="text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
            >
              {mfaCopy.common.signOutAndRestart}
            </button>
          </div>
        )}
      </div>

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

function methodLabel(method: string): string {
  if (method === 'passkey') return mfaCopy.setup.passkeyCardTitle
  if (method === 'totp') return mfaCopy.setup.totpCardTitle
  return method
}

function FactorRow({ label, added }: { label: string; added: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-sm">
      <span className="text-zinc-200">{label}</span>
      <span className={'flex items-center gap-1 text-xs ' + (added ? 'text-teal-300' : 'text-zinc-500')}>
        {added ? <IconCheck size={14} aria-hidden="true" /> : null}
        {added ? mfaCopy.setup.reviewAdded : mfaCopy.setup.reviewMissing}
      </span>
    </div>
  )
}

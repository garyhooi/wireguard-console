import { useState } from 'react'
import { GhostButton, Modal, PrimaryButton, inputCls, labelCls } from './ui'

/**
 * Confirm2FA — step-up authentication modal for sensitive actions
 * (reset 2FA / password, change email / role, download / restore backup).
 *
 * The acting admin must enter their own current 6-digit authenticator code;
 * the server verifies it before performing the action. Rendered by pages
 * that hold the pending action, e.g.:
 *
 *   const [pending, setPending] = useState<null | (() => Promise<void>)>(null)
 *   ...
 *   <button onClick={() => setPending(() => async () => { await doThing(code) })} />
 *   <Confirm2FA open={pending !== null} onClose={() => setPending(null)}
 *              title="Reset 2FA" description="..." onSubmit={pending} />
 *
 * The parent stores the *action factory* (it receives the code) so the modal
 * can run it with the code the admin typed.
 */

interface Confirm2FAProps {
  open: boolean
  title: string
  description?: string
  /** Action factory: receives the entered code, returns the fetch promise. */
  onSubmit: ((code: string) => Promise<void>) | null
  onClose: () => void
  submitLabel?: string
  errorMessage?: string | null
}

export function Confirm2FA({
  open,
  title,
  description,
  onSubmit,
  onClose,
  submitLabel = 'Confirm',
  errorMessage,
}: Confirm2FAProps) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const handleSubmit = async () => {
    if (!onSubmit || code.length !== 6 || busy) return
    setBusy(true)
    setError('')
    setSuccess('')
    try {
      await onSubmit(code)
      setSuccess('Done.')
      setCode('')
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verification failed')
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    if (busy) return
    setCode('')
    setError('')
    setSuccess('')
    onClose()
  }

  return (
    <Modal open={open} onClose={close} title={title} className="max-w-md">
      <div className="space-y-4">
        {description && <p className="text-sm text-zinc-400 leading-relaxed">{description}</p>}
        {errorMessage && <p className="text-sm text-amber-400">{errorMessage}</p>}

        <div>
          <label htmlFor="confirm2fa-code" className={labelCls}>
            Your 6-digit authenticator code
          </label>
          <input
            id="confirm2fa-code"
            type="text"
            inputMode="numeric"
            maxLength={6}
            autoFocus
            className={`${inputCls} text-center text-2xl tracking-widest font-mono`}
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit()
            }}
          />
          <p className="text-xs text-zinc-600 mt-1">
            Required to authorize this action. This confirms it's really you.
          </p>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}
        {success && <p className="text-sm text-teal-400">{success}</p>}

        <div className="flex justify-end gap-3 pt-1">
          <GhostButton onClick={close} disabled={busy}>
            Cancel
          </GhostButton>
          <PrimaryButton onClick={handleSubmit} disabled={busy || code.length !== 6}>
            {busy ? 'Verifying…' : submitLabel}
          </PrimaryButton>
        </div>
      </div>
    </Modal>
  )
}

import { useQuery } from '@tanstack/react-query'
import { apiJson } from './api'

/**
 * MFA step-up grace window (Configuration → Security).
 *
 * The server is authoritative: a sensitive action accepts an empty code
 * when the SAME session already passed a step-up verification inside the
 * configured window (config.step_up_minutes / admin_sessions.step_up_*).
 * A successful passkey step-up stamps the session too, so the gated action
 * can then run with an empty code (the server consumes the fresh stamp
 * exactly once). Login always requires verification — this only governs
 * step-up prompts.
 *
 * The UI keeps the server as the decision-maker: gated pages first call the
 * action with an empty code, and only open the ConfirmMFA modal when the
 * server answers with an MFA-related error. When the window is 0 (grace
 * disabled, the default) that probe would always fail, so pages skip it and
 * open the modal directly — one fewer doomed round-trip per action.
 */

/** The configured window (0 = disabled / ask every time). */
export function useStepUpMinutes(): number {
  const { data } = useQuery<{ step_up_minutes: number }>({
    queryKey: ['stepup-config'],
    queryFn: async () => {
      return apiJson<{ step_up_minutes: number }>('/api/config/step-up')
    },
    staleTime: 60_000,
  })
  return data?.step_up_minutes ?? 0
}

/**
 * Error codes the server uses when a gated action was rejected by the MFA
 * step-up itself (missing code / not enrolled / wrong code / failed passkey
 * ceremony / last-factor refusal) rather than by a real action error.
 */
const MFA_ERROR_CODES = [
  // Contract §2 codes.
  'mfa_code_required',
  'mfa_not_enrolled',
  'mfa_invalid',
  'mfa_passkey_failed',
  'mfa_last_factor',
  // Codes the backend actually emits for the same conditions (backend-core
  // uses mfa_required for "a step-up code is needed" and mfa_no_factor for an
  // actor with no enrolled factor).
  'mfa_required',
  'mfa_no_factor',
]

/**
 * isMFAError reports whether a rejected gated action failed because of the
 * MFA step-up itself rather than a real action error. Only these should
 * surface the ConfirmMFA modal.
 *
 * Prefers the machine-readable ApiError.code from the error envelope; falls
 * back to message matching for older handlers that only return {"error"}.
 */
export function isMFAError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && MFA_ERROR_CODES.includes(code)) return true
  }
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return (
    message.includes('MFA code is required') ||
    message.includes('must have MFA enabled') ||
    message.includes('must have multi-factor') ||
    message.includes('Invalid MFA code') ||
    message.includes('verification code is required')
  )
}

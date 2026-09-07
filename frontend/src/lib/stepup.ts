import { useQuery } from '@tanstack/react-query'
import { apiJson } from './api'

/**
 * 2FA step-up grace window (Configuration → Security).
 *
 * The server is authoritative: a sensitive action accepts an empty code
 * when the SAME session already passed a step-up code inside the configured
 * window (config.step_up_minutes / admin_sessions.step_up_verified_at).
 * Login always requires verification — this only governs step-up prompts.
 *
 * The UI keeps the server as the decision-maker: gated pages first call the
 * action with an empty code, and only open the Confirm2FA modal when the
 * server answers with a 2FA-related error. When the window is 0 (grace
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
 * is2FAError reports whether a rejected gated action failed because of the
 * 2FA step-up itself (code missing/invalid/not enrolled) rather than a
 * real action error. Only these should surface the Confirm2FA modal.
 */
export function is2FAError(message: string): boolean {
  return (
    message.includes('2FA code is required') ||
    message.includes('must have 2FA enabled') ||
    message.includes('Invalid 2FA code') ||
    message.includes('verification code')
  )
}

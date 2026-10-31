// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mocks = vi.hoisted(() => ({ navigateTo: vi.fn() }))

vi.mock('../../lib/mfaClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mfaClient')>()
  return { ...actual, navigateTo: mocks.navigateTo }
})

import { LoginPage } from '../login'

function renderLogin() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <LoginPage />
    </QueryClientProvider>,
  )
}

function jsonRes(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response
}

let lockoutStatus: { locked: boolean; retry_after_seconds: number }
let loginReply: { status: number; body: unknown }

describe('LoginPage', () => {
  beforeEach(() => {
    // jsdom has no canvas backend; the hologram component must degrade quietly.
    HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext
    mocks.navigateTo.mockReset()
    lockoutStatus = { locked: false, retry_after_seconds: 0 }
    loginReply = { status: 401, body: { error: 'Invalid email or password' } }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/api/auth/lockout-status')) return jsonRes(lockoutStatus)
        if (u.includes('/api/auth/login')) return jsonRes(loginReply.body, loginReply.status)
        return jsonRes({}, 404)
      }),
    )
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    mocks.navigateTo.mockReset()
  })

  function submitCredentials() {
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'admin@example.com' } })
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
  }

  it('renders the sign-in form above the holographic backdrop', () => {
    renderLogin()
    expect(screen.getByRole('heading', { name: 'WireGuard Console' })).toBeTruthy()
    expect(screen.getByLabelText(/email address/i)).toBeTruthy()
    expect(screen.getByLabelText(/^password$/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy()
    const canvas = document.querySelector('canvas[aria-hidden="true"]')
    expect(canvas).not.toBeNull()
  })

  it('plays the red verification animation on a wrong password (no reload)', async () => {
    renderLogin()
    submitCredentials()
    expect(await screen.findByText('VERIFICATION FAILED')).toBeTruthy()
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('shows the lockout countdown when the API answers 429', async () => {
    loginReply = {
      status: 429,
      body: { error: 'Too many failed login attempts. Try again later.', retry_after_seconds: 3 },
    }
    renderLogin()
    submitCredentials()
    expect(await screen.findByText('TOO MANY ATTEMPTS')).toBeTruthy()
    expect(screen.getByTestId('lockout-remaining').textContent).toBe('0:03')
  })

  it('resumes an existing lockout after a refresh via lockout-status', async () => {
    lockoutStatus = { locked: true, retry_after_seconds: 45 }
    renderLogin()
    expect(await screen.findByText('TOO MANY ATTEMPTS')).toBeTruthy()
    expect(screen.getByTestId('lockout-remaining').textContent).toBe('0:45')
  })

  it('continues an enrolled admin to /mfa-verify after a correct password', async () => {
    loginReply = {
      status: 200,
      body: {
        pending_mfa: true,
        mfa_methods: ['passkey', 'totp'],
        passkey_available: true,
        passkey_count: 1,
        recovery_codes_remaining: 8,
        require_methods: 'any',
        admin: { id: 'a1', email: 'admin@example.com', role: 'super_admin' },
      },
    }
    renderLogin()
    submitCredentials()
    await waitFor(() => expect(mocks.navigateTo).toHaveBeenCalledWith('/mfa-verify'))
    // A pending challenge is not a completed sign-in: no success animation.
    expect(screen.queryByText('IDENTITY VERIFIED')).toBeNull()
    expect(screen.queryByText('VERIFICATION FAILED')).toBeNull()
  })

  it('sends an admin without factors to the forced enrollment page', async () => {
    loginReply = {
      status: 200,
      body: {
        pending_mfa_setup: true,
        setup_methods: ['totp', 'passkey'],
        passkey_available: true,
        passkey_count: 0,
        recovery_codes_remaining: 0,
        require_methods: 'any',
        admin: { id: 'a1', email: 'admin@example.com', role: 'admin' },
      },
    }
    renderLogin()
    submitCredentials()
    await waitFor(() => expect(mocks.navigateTo).toHaveBeenCalledWith('/mfa-setup?forced=1'))
  })

  it('never treats a bare 200 as a signed-in session', async () => {
    loginReply = {
      status: 200,
      body: { csrf_token: 'forged-session', admin: { id: 'a1' } },
    }
    renderLogin()
    submitCredentials()
    expect(await screen.findByText('VERIFICATION FAILED')).toBeTruthy()
    expect(mocks.navigateTo).not.toHaveBeenCalled()
  })
})

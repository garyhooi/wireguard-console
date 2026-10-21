// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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

describe('LoginPage', () => {
  beforeEach(() => {
    // jsdom has no canvas backend; the hologram component must degrade quietly.
    HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext
  })
  afterEach(cleanup)

  it('renders the sign-in form above the holographic backdrop', () => {
    renderLogin()
    expect(screen.getByRole('heading', { name: 'WireGuard Console' })).toBeTruthy()
    expect(screen.getByLabelText(/email address/i)).toBeTruthy()
    expect(screen.getByLabelText(/^password$/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy()
    // Decorative canvas is present but hidden from assistive tech.
    const canvas = document.querySelector('canvas[aria-hidden="true"]')
    expect(canvas).not.toBeNull()
  })
})

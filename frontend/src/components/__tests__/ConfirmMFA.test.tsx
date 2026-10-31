// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfirmMFA } from '../../lib/ConfirmMFA'

// ConfirmMFA resolves passkey availability through mfaClient when the caller
// does not know it; both paths are mocked so no WebAuthn/fetch runs.
const mfaMocks = vi.hoisted(() => ({
  getMFAStatus: vi.fn(),
  startPasskeyStepUp: vi.fn(),
}))
vi.mock('../../lib/mfaClient', () => mfaMocks)

function renderModal(props: Partial<React.ComponentProps<typeof ConfirmMFA>> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  const onSubmit = props.onSubmit ?? vi.fn(async () => {})
  const onClose = props.onClose ?? vi.fn()
  const utils = render(
    <QueryClientProvider client={qc}>
      <ConfirmMFA
        open
        title="Confirm with MFA"
        description="Confirm this action."
        onSubmit={onSubmit}
        onClose={onClose}
        {...props}
      />
    </QueryClientProvider>,
  )
  return { ...utils, onSubmit, onClose }
}

describe('ConfirmMFA', () => {
  beforeEach(() => {
    mfaMocks.getMFAStatus.mockReset()
    mfaMocks.startPasskeyStepUp.mockReset()
    mfaMocks.getMFAStatus.mockResolvedValue({
      mfa_enabled: true,
      methods: ['totp'],
      passkey_available: false,
      require_methods: 'any',
      recovery_codes_remaining: 10,
      factors: [],
      totp_enabled: true,
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('runs the action with the typed authenticator code and closes on success', async () => {
    const { onSubmit, onClose } = renderModal({ passkeyAvailable: false })

    const input = screen.getByLabelText('Authenticator or recovery code') as HTMLInputElement
    const confirm = screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    fireEvent.change(input, { target: { value: '123456' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('123456'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('accepts a longer recovery code in the same field', async () => {
    const { onSubmit } = renderModal({ passkeyAvailable: false })
    const input = screen.getByLabelText('Authenticator or recovery code')
    // Separators are stripped and the value upper-cased.
    fireEvent.change(input, { target: { value: 'abcd-efgh-1234' } })
    expect((input as HTMLInputElement).value).toBe('ABCDEFGH1234')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('ABCDEFGH1234'))
  })

  it('offers a passkey first, proves it, then runs the action with an empty code', async () => {
    mfaMocks.startPasskeyStepUp.mockResolvedValue(undefined)
    const { onSubmit, onClose } = renderModal({ passkeyAvailable: true })

    const usePasskey = screen.getByRole('button', { name: 'Use passkey' })
    fireEvent.click(usePasskey)

    await waitFor(() => expect(mfaMocks.startPasskeyStepUp).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(''))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('hides the passkey action when no passkey is available', async () => {
    renderModal({ passkeyAvailable: false })
    expect(screen.queryByRole('button', { name: 'Use passkey' })).toBeNull()
    expect(screen.getByLabelText('Authenticator or recovery code')).toBeTruthy()
  })

  it('shows a failed passkey ceremony error and keeps the modal open', async () => {
    mfaMocks.startPasskeyStepUp.mockRejectedValue(new Error('Passkey prompt was cancelled'))
    const { onSubmit, onClose } = renderModal({ passkeyAvailable: true })

    fireEvent.click(screen.getByRole('button', { name: 'Use passkey' }))

    await screen.findByText('Passkey prompt was cancelled')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows an action error and keeps the modal open', async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error('That code is not valid')
    })
    const onClose = vi.fn()
    renderModal({ passkeyAvailable: false, onSubmit, onClose })

    fireEvent.change(screen.getByLabelText('Authenticator or recovery code'), {
      target: { value: '000000' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    await screen.findByText('That code is not valid')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('explains when the action needs MFA enrollment first', async () => {
    const onSubmit = vi.fn(async () => {
      const err = new Error('Your account must have MFA enabled to perform this action') as Error & {
        code?: string
      }
      err.code = 'mfa_not_enrolled'
      throw err
    })
    renderModal({ passkeyAvailable: false, onSubmit })

    fireEvent.change(screen.getByLabelText('Authenticator or recovery code'), {
      target: { value: '111111' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    await screen.findByText(/must be set up in Profile before this action/)
    // The raw server message is replaced by the actionable copy.
    expect(screen.queryByText('Your account must have MFA enabled to perform this action')).toBeNull()
  })

  it('does not render when closed', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <ConfirmMFA
          open={false}
          title="Confirm with MFA"
          onSubmit={vi.fn(async () => {})}
          onClose={vi.fn()}
          passkeyAvailable={false}
        />
      </QueryClientProvider>,
    )
    expect(screen.queryByLabelText('Authenticator or recovery code')).toBeNull()
  })
})

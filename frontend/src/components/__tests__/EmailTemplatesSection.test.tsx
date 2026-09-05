// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  }
})
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EmailTemplatesSection } from '../../components/EmailTemplatesSection'
import { serializeEmailDocument } from '../../lib/RichTextEditor'

function renderWithClient(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const templates = [
  {
    key: 'user_invite',
    subject: "You've been invited to join WireGuard Console",
    body: '<html><body style="color:#333;"><h2>Welcome</h2><p>Hello {{full_name}}, click <a href="{{invite_link}}">here</a>.</p></body></html>',
    updated_at: '2026-01-02T03:04:05Z',
  },
  {
    key: 'peer_config',
    subject: 'Your WireGuard configuration is ready',
    body: '<html><body><h2>Peer ready</h2></body></html>',
    updated_at: '2026-01-03T03:04:05Z',
  },
]

beforeEach(() => {
  localStorage.setItem('token', 'test-token')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url.includes('/api/config/email-templates') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => templates,
        } as Response
      }
      if (url.includes('/api/config/email-templates') && method === 'PATCH') {
        return { ok: true, status: 200, json: async () => ({ status: 'updated' }) } as Response
      }
      throw new Error(`Unexpected request ${method} ${url}`)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('EmailTemplatesSection', () => {
  it('loads templates and lists them in the sidebar', async () => {
    renderWithClient(<EmailTemplatesSection />)
    await waitFor(() => expect(screen.getAllByText('User invite').length).toBeGreaterThan(0))
    expect(screen.getAllByText('Peer configuration').length).toBeGreaterThan(0)
    // First template auto-selected → its key code chip appears
    expect(screen.getByText('user_invite')).toBeTruthy()
  })

  it('switches between templates in the picker', async () => {
    renderWithClient(<EmailTemplatesSection />)
    await waitFor(() => expect(screen.getAllByText('Peer configuration').length).toBeGreaterThan(0))
    // Picker shows both labels; the editor heading also uses the same label,
    // so pick the sidebar list item first.
    const peerBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes('Peer configuration'))!
    peerBtn.click()
    await waitFor(() =>
      expect(
        screen.getByDisplayValue('Your WireGuard configuration is ready'),
      ).toBeTruthy(),
    )
  })

  it('marks a template dirty and sends PATCH with subject + body on save', async () => {
    renderWithClient(<EmailTemplatesSection />)
    await waitFor(() => expect(screen.getAllByText('User invite').length).toBeGreaterThan(0))

    const subjectInput = screen.getByLabelText('Subject')
    // fireEvent would be cleaner; a native setter + input event works without
    // importing user-event.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(subjectInput, 'New subject line')
    subjectInput.dispatchEvent(new Event('input', { bubbles: true }))

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Save template/ }),
      ).toBeTruthy(),
    )

    const saveBtn = screen.getByRole('button', { name: /Save template/ })
    saveBtn.click()

    await waitFor(() =>
      expect(
        screen.getByText('Template "User invite" saved.'),
      ).toBeTruthy(),
    )
    const fetchMock = vi.mocked(fetch)
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'PATCH',
    )
    expect(patchCall).toBeTruthy()
    const body = JSON.parse((patchCall![1] as RequestInit).body as string)
    expect(body.subject).toBe('New subject line')
    expect(body.body).toContain('{{invite_link}}')
  })
})

describe('serializeEmailDocument', () => {
  it('round-trips an authored document without a synthesized <head>', () => {
    const doc = document.implementation.createHTMLDocument('x')
    doc.documentElement.innerHTML =
      '<body style="color:#333;"><h2>Welcome</h2><p>Hello</p></body>'
    const out = serializeEmailDocument(doc)
    expect(out).toContain('<h2>Welcome</h2>')
    expect(out).not.toMatch(/<head>/i)
  })
})

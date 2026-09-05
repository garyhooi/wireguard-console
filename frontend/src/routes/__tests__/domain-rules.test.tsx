// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  }
})
import { render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DomainRulesPage } from '../_authenticated/domain-rules'

function renderWithClient(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const rules = [
  {
    id: 'r-global',
    scope: 'global',
    user_id: null,
    user_email: '',
    user_full_name: '',
    domain: 'global-block.example',
    created_by: null,
    created_at: '2026-01-05T09:00:00Z',
  },
  {
    id: 'r-user-named',
    scope: 'user',
    user_id: 'u1',
    user_email: 'alice@example.com',
    user_full_name: 'Alice Tan',
    domain: 'tracker.io',
    created_by: null,
    created_at: '2026-01-06T09:00:00Z',
  },
  {
    id: 'r-user-email',
    scope: 'user',
    user_id: 'u2',
    user_email: 'bob@example.com',
    user_full_name: '',
    domain: 'ads.example',
    created_by: null,
    created_at: '2026-01-07T09:00:00Z',
  },
]

const status = {
  reachable: true,
  protection_on: true,
  blocking_mode: 'custom_ip',
  blocking_ipv4: '10.8.0.1',
  expected_rules: 3,
  missing_rules: 0,
  block_page_ip: '10.8.0.1',
}

describe('DomainRulesPage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/domain-rules/status')) {
          return { ok: true, status: 200, json: async () => status } as Response
        }
        if (url.includes('/api/domain-rules')) {
          return { ok: true, status: 200, json: async () => rules } as Response
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
  })

  it('shows the actual user for user-scoped rules instead of the literal "User"', async () => {
    renderWithClient(<DomainRulesPage />)
    await waitFor(() => expect(screen.getByText('||tracker.io^')).toBeTruthy())

    // Named user rule → full name.
    const namedRow = screen.getByText('||tracker.io^').closest('tr')!
    expect(within(namedRow).getByText('Alice Tan')).toBeTruthy()
    expect(within(namedRow).queryByText('User')).toBeNull()

    // User rule whose owner has no full name → falls back to email.
    const emailRow = screen.getByText('||ads.example^').closest('tr')!
    expect(within(emailRow).getByText('bob@example.com')).toBeTruthy()
    expect(within(emailRow).queryByText('User')).toBeNull()

    // Global rule has no user → em dash.
    const globalRow = screen.getByText('||global-block.example^').closest('tr')!
    expect(within(globalRow).getByText('—')).toBeTruthy()
  })
})

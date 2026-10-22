// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  }
})
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

const departments = [
  { id: 'd1', name: 'Engineering', user_count: 4, created_at: '2026-01-01T00:00:00Z' },
  { id: 'd2', name: 'Sales', user_count: 0, created_at: '2026-01-02T00:00:00Z' },
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

const users = [
  { id: 'u1', email: 'alice@example.com', full_name: 'Alice Tan' },
  { id: 'u2', email: 'bob@example.com', full_name: 'Bob Lee' },
]

// u1 owns two active peers plus one removed peer; u2's peer must never leak in.
const peers = [
  { id: 'p1', user_id: 'u1', name: 'Alice Laptop', allowed_ip: '10.8.0.2/32', status: 'active' },
  { id: 'p2', user_id: 'u1', name: 'Alice Phone', allowed_ip: '10.8.0.3/32', status: 'active' },
  { id: 'p3', user_id: 'u2', name: 'Bob Laptop', allowed_ip: '10.8.0.4/32', status: 'active' },
  { id: 'p-old', user_id: 'u1', name: 'Alice Old', allowed_ip: '10.8.0.9/32', status: 'removed' },
]

/** Full fetch mock for the Add Rule modal with a user selected. */
function userScopeFetchMock(ruleRows: unknown[] = rules) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/domain-rules' && init?.method === 'POST') return jsonRes({}, 201)
    if (url.includes('/api/domain-rules/status')) return jsonRes(status)
    if (url.includes('/api/departments')) return jsonRes(departments)
    if (url.includes('/api/domain-groups')) return jsonRes([])
    if (url === '/api/users') return jsonRes(users)
    if (url === '/api/peers') return jsonRes(peers)
    if (url.includes('/api/domain-rules')) return jsonRes(ruleRows)
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Open the Add Rule modal, switch to user scope, and pick user u1. */
async function openUserScopedRuleDialog() {
  fireEvent.click(await screen.findByRole('button', { name: 'Add Rule' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('Scope'), { target: { value: 'user' } })
  const userSelect = within(dialog).getByLabelText('User')
  await waitFor(() =>
    expect(within(userSelect).getByRole('option', { name: /Alice Tan/ })).toBeTruthy(),
  )
  fireEvent.change(userSelect, { target: { value: 'u1' } })
  return dialog
}

function jsonRes(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response
}

describe('DomainRulesPage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/domain-rules/status')) {
          return { ok: true, status: 200, json: async () => status } as Response
        }
        if (url.includes('/api/departments')) return jsonRes(departments)
        if (url.includes('/api/domain-groups')) {
          return { ok: true, status: 200, json: async () => [] } as Response
        }
        if (url.includes('/api/domain-rules')) {
          return { ok: true, status: 200, json: async () => rules } as Response
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('shows the actual user for user-scoped rules instead of the literal "User"', async () => {
    renderWithClient(<DomainRulesPage />)
    await waitFor(() => expect(screen.getByText('||tracker.io^')).toBeTruthy())

    // Named user rule → "Name <email>" (plus department once the backend sends it).
    const namedRow = screen.getByText('||tracker.io^').closest('tr')!
    expect(within(namedRow).getByText('Alice Tan <alice@example.com>')).toBeTruthy()
    expect(within(namedRow).queryByText('User')).toBeNull()

    // User rule whose owner has no full name → falls back to email.
    const emailRow = screen.getByText('||ads.example^').closest('tr')!
    expect(within(emailRow).getByText('bob@example.com')).toBeTruthy()
    expect(within(emailRow).queryByText('User')).toBeNull()

    // Global rule has no user → em dash.
    const globalRow = screen.getByText('||global-block.example^').closest('tr')!
    expect(within(globalRow).getByText('—')).toBeTruthy()
  })

  it('shows a red protection-paused banner when AdGuard protection is paused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/domain-rules/status')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ...status,
              protection_enabled: false,
              protection_disabled_duration: 10 * 60 * 1000,
            }),
          } as Response
        }
        if (url.includes('/api/departments')) return jsonRes(departments)
        if (url.includes('/api/domain-groups')) {
          return { ok: true, status: 200, json: async () => [] } as Response
        }
        if (url.includes('/api/domain-rules')) {
          return { ok: true, status: 200, json: async () => rules } as Response
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    renderWithClient(<DomainRulesPage />)
    const paused = await screen.findByText(/AdGuard protection is paused — blocking is disabled/)
    expect(paused.textContent).toContain('~10 min')
    expect(paused.closest('[role="status"]')?.className).toContain('bg-red-500/10')
    expect(screen.queryByText(/AdGuard reachable —/)).toBeNull()
  })

  it('tests a domain and shows a blocked result with the matched rule', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/domain-rules/check')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            domain: 'youtube.com',
            blocked: true,
            reachable: true,
            protection_enabled: true,
            filtering_enabled: true,
            reason: 'FilteredBlackList',
            rules: [{ text: '||youtube.com^', filter_list_id: 1 }],
          }),
        } as Response
      }
      if (url.includes('/api/domain-rules/status')) {
        return { ok: true, status: 200, json: async () => status } as Response
      }
      if (url.includes('/api/domain-groups')) {
        return { ok: true, status: 200, json: async () => [] } as Response
      }
      if (url.includes('/api/domain-rules')) {
        return { ok: true, status: 200, json: async () => rules } as Response
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithClient(<DomainRulesPage />)
    const input = await screen.findByLabelText('Test domain')
    fireEvent.change(input, { target: { value: 'youtube.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))

    await waitFor(() => expect(screen.getByText('Blocked (FilteredBlackList)')).toBeTruthy())
    expect(screen.getByText('||youtube.com^')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/domain-rules/check?domain=youtube.com'),
      expect.anything(),
    )
  })

  it('tests a domain and shows an allowed result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/domain-rules/check')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              domain: 'example.org',
              blocked: false,
              reachable: true,
              protection_enabled: true,
              filtering_enabled: true,
            }),
          } as Response
        }
        if (url.includes('/api/domain-rules/status')) {
          return { ok: true, status: 200, json: async () => status } as Response
        }
        if (url.includes('/api/departments')) return jsonRes(departments)
        if (url.includes('/api/domain-groups')) {
          return { ok: true, status: 200, json: async () => [] } as Response
        }
        if (url.includes('/api/domain-rules')) {
          return { ok: true, status: 200, json: async () => rules } as Response
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    renderWithClient(<DomainRulesPage />)
    const input = await screen.findByLabelText('Test domain')
    fireEvent.change(input, { target: { value: 'example.org' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))

    await waitFor(() => expect(screen.getByText('Allowed by AdGuard')).toBeTruthy())
    // Only the check result would start with "Blocked (…)" — the static certificate
    // copy above this form also begins with the word "Blocked".
    expect(screen.queryByText(/^Blocked \(/)).toBeNull()
  })

  it('lists domain groups and shows group-targeted rules as a group chip', async () => {
    const groupRule = {
      ...rules[0],
      id: 'r-group',
      domain: '',
      group_id: 'g1',
      group_name: 'YouTube',
    }
    const groups = [
      {
        id: 'g1',
        name: 'YouTube',
        domains: ['youtube.com', 'ytimg.com', 'googlevideo.com'],
        domain_count: 3,
        rule_count: 1,
        created_at: '2026-01-08T09:00:00Z',
      },
      {
        id: 'g2',
        name: 'Social',
        domains: ['facebook.com'],
        domain_count: 1,
        rule_count: 0,
        created_at: '2026-01-09T09:00:00Z',
      },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/departments')) return jsonRes(departments)
        if (url.includes('/api/domain-groups')) return jsonRes(groups)
        if (url.includes('/api/domain-rules/status')) return jsonRes(status)
        if (url.includes('/api/domain-rules')) return jsonRes([...rules, groupRule])
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    renderWithClient(<DomainRulesPage />)
    await screen.findByText('used by 1 rule')

    // Group row: name, domain count, rule count, and edit/delete actions.
    expect(screen.getByText('Social')).toBeTruthy()
    expect(screen.getByText('used by 0 rules')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit YouTube' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete YouTube' })).toBeTruthy()

    // The group-targeted rule renders a chip instead of an empty ||^ domain.
    const ruleRow = (await screen.findByText('Group:')).closest('tr')!
    expect(within(ruleRow).getByText('YouTube')).toBeTruthy()
    expect(within(ruleRow).getByText('3 domains')).toBeTruthy()
    expect(within(ruleRow).queryByText('||^')).toBeNull()

    // Expanding a group reveals its domains as compact chips.
    fireEvent.click(screen.getByRole('button', { name: 'YouTube' }))
    expect(await screen.findByText('ytimg.com')).toBeTruthy()
  })

  it('creates a group from the modal with parsed and de-duplicated domains', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/domain-groups' && init?.method === 'POST') {
        return jsonRes(
          {
            id: 'g-new',
            name: 'YouTube',
            domains: [],
            domain_count: 0,
            rule_count: 0,
            created_at: '',
          },
          201,
        )
      }
      if (url.includes('/api/departments')) return jsonRes(departments)
      if (url.includes('/api/domain-groups')) return jsonRes([])
      if (url.includes('/api/domain-rules/status')) return jsonRes(status)
      if (url.includes('/api/domain-rules')) return jsonRes(rules)
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithClient(<DomainRulesPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'New group' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'YouTube' },
    })
    fireEvent.change(within(dialog).getByLabelText('Domains'), {
      target: { value: 'youtube.com\n YTIMG.com, youtube.com\n\ngooglevideo.com' },
    })

    // Live count: trimmed, blank lines dropped, case-insensitive de-dupe.
    expect(within(dialog).getByText('3 domains')).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create group' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/domain-groups' && init?.method === 'POST',
      )
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        name: 'YouTube',
        // De-duped case-insensitively, keeping the first spelling.
        domains: ['youtube.com', 'YTIMG.com', 'googlevideo.com'],
      })
    })
  })

  it('adds a rule for a domain group by sending group_id', async () => {
    const groups = [
      {
        id: 'g1',
        name: 'YouTube',
        domains: ['youtube.com'],
        domain_count: 1,
        rule_count: 0,
        created_at: '2026-01-08T09:00:00Z',
      },
    ]
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/domain-rules' && init?.method === 'POST') return jsonRes({}, 201)
      if (url.includes('/api/domain-groups')) return jsonRes(groups)
      if (url.includes('/api/domain-rules/status')) return jsonRes(status)
      if (url.includes('/api/domain-rules')) return jsonRes(rules)
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithClient(<DomainRulesPage />)
    // Wait for the groups query so the selector has its option.
    await screen.findByText('used by 0 rules')
    fireEvent.click(await screen.findByRole('button', { name: 'Add Rule' }))
    const dialog = await screen.findByRole('dialog')

    // Group target replaces the domain input with a group selector.
    fireEvent.change(within(dialog).getByLabelText('Target'), {
      target: { value: 'group' },
    })
    expect(within(dialog).queryByLabelText('Domain')).toBeNull()
    fireEvent.change(within(dialog).getByLabelText('Domain group'), {
      target: { value: 'g1' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Rule' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/domain-rules' && init?.method === 'POST',
      )
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        scope: 'global',
        group_id: 'g1',
      })
    })
  })

  it('adds a rule for a department scope by sending department_id only', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/domain-rules' && init?.method === 'POST') return jsonRes({}, 201)
      if (url.includes('/api/departments')) return jsonRes(departments)
      if (url.includes('/api/domain-groups')) return jsonRes([])
      if (url.includes('/api/domain-rules/status')) return jsonRes(status)
      if (url.includes('/api/domain-rules')) return jsonRes([])
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithClient(<DomainRulesPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add Rule' }))
    const dialog = await screen.findByRole('dialog')

    // Department scope swaps the user picker for the department picker.
    fireEvent.change(within(dialog).getByLabelText('Scope'), {
      target: { value: 'department' },
    })
    expect(within(dialog).queryByLabelText('User')).toBeNull()
    const departmentSelect = within(dialog).getByLabelText('Department')
    await waitFor(() =>
      expect(
        within(departmentSelect).getByRole('option', { name: /Engineering/ }),
      ).toBeTruthy(),
    )
    fireEvent.change(departmentSelect, { target: { value: 'd1' } })
    fireEvent.change(within(dialog).getByLabelText('Domain'), {
      target: { value: 'ads.example' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Rule' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/domain-rules' && init?.method === 'POST',
      )
      expect(call).toBeTruthy()
      // Exactly one of user_id / department_id: department rules never send user_id.
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        scope: 'department',
        department_id: 'd1',
        domain: 'ads.example',
      })
    })
  })

  it('offers the block page certificate download and platform install instructions', async () => {
    renderWithClient(<DomainRulesPage />)
    await waitFor(() => expect(screen.getByText('||tracker.io^')).toBeTruthy())

    // The card links straight at the Caddy static file — a plain anchor, no API fetch.
    expect(screen.getByText('Block page certificate')).toBeTruthy()
    const download = screen.getByRole('link', { name: 'Download certificate' })
    expect(download.getAttribute('href')).toBe('/ca.crt')
    expect(download.hasAttribute('download')).toBe(true)

    // "Install instructions" opens the modal on the default iOS steps.
    fireEvent.click(screen.getByRole('button', { name: 'Install instructions' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Install the block page certificate')).toBeTruthy()
    expect(within(dialog).getByText(/Certificate Trust Settings/)).toBeTruthy()

    // Switching platforms swaps in that platform's steps.
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Windows' }))
    expect(
      within(dialog).getAllByText(/Trusted Root Certification Authorities/).length,
    ).toBeGreaterThan(0)
    expect(within(dialog).getByText(/certutil -addstore/)).toBeTruthy()

    // macOS: a copyable terminal command (import + trust in one step) plus the
    // -25294 / "untrusted" troubleshooting note.
    fireEvent.click(within(dialog).getByRole('tab', { name: 'macOS' }))
    expect(within(dialog).getByText(/security add-trusted-cert/)).toBeTruthy()
    expect(within(dialog).getByText(/error -25294/)).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Copy' })).toBeTruthy()
  })

  it('offers peer checkboxes only for user scope after choosing a user', async () => {
    userScopeFetchMock()
    renderWithClient(<DomainRulesPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add Rule' }))
    const dialog = await screen.findByRole('dialog')

    // Global scope has no peer selection.
    expect(within(dialog).queryByText('Peers')).toBeNull()

    fireEvent.change(within(dialog).getByLabelText('Scope'), { target: { value: 'user' } })
    // A user must be chosen before its peers can be listed.
    expect(within(dialog).queryByText('Peers')).toBeNull()

    const userSelect = within(dialog).getByLabelText('User')
    await waitFor(() =>
      expect(within(userSelect).getByRole('option', { name: /Alice Tan/ })).toBeTruthy(),
    )
    fireEvent.change(userSelect, { target: { value: 'u1' } })

    // Only u1's active peers: no other user's peer, no removed peer.
    expect(await within(dialog).findByRole('checkbox', { name: /Alice Laptop/ })).toBeTruthy()
    expect(within(dialog).getByRole('checkbox', { name: /Alice Phone/ })).toBeTruthy()
    expect(within(dialog).queryByRole('checkbox', { name: /Bob Laptop/ })).toBeNull()
    expect(within(dialog).queryByRole('checkbox', { name: /Alice Old/ })).toBeNull()
    expect(
      within(dialog).getByText('Leave all unchecked to apply to every peer of this user.'),
    ).toBeTruthy()
  })

  it('sends peer_ids when specific peers are selected', async () => {
    const fetchMock = userScopeFetchMock()
    renderWithClient(<DomainRulesPage />)
    const dialog = await openUserScopedRuleDialog()

    fireEvent.click(await within(dialog).findByRole('checkbox', { name: /Alice Laptop/ }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Alice Phone/ }))
    fireEvent.change(within(dialog).getByLabelText('Domain'), {
      target: { value: 'ads.example' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Rule' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/domain-rules' && init?.method === 'POST',
      )
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        scope: 'user',
        user_id: 'u1',
        domain: 'ads.example',
        peer_ids: ['p1', 'p2'],
      })
    })
  })

  it('omits peer_ids when no peers are selected (all peers of the user)', async () => {
    const fetchMock = userScopeFetchMock()
    renderWithClient(<DomainRulesPage />)
    const dialog = await openUserScopedRuleDialog()

    // Wait for the peers list so an empty selection is a real "all peers" choice.
    await within(dialog).findByRole('checkbox', { name: /Alice Laptop/ })
    fireEvent.change(within(dialog).getByLabelText('Domain'), {
      target: { value: 'ads.example' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Rule' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/domain-rules' && init?.method === 'POST',
      )
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        scope: 'user',
        user_id: 'u1',
        domain: 'ads.example',
      })
    })
  })

  it('shows the peer scope for user rules in the rules table', async () => {
    userScopeFetchMock([
      {
        ...rules[1],
        id: 'r-all-peers',
        domain: 'all-peers.example',
        peer_ids: [],
      },
      {
        ...rules[1],
        id: 'r-some-peers',
        domain: 'some-peers.example',
        peer_ids: ['p1', 'p2'],
        peer_names: ['Alice Laptop', 'Alice Phone'],
      },
    ])
    renderWithClient(<DomainRulesPage />)

    await screen.findByText('||all-peers.example^')
    const allRow = screen.getByText('||all-peers.example^').closest('tr')!
    expect(within(allRow).getByText('All peers')).toBeTruthy()

    const someRow = screen.getByText('||some-peers.example^').closest('tr')!
    expect(within(someRow).getByText('Peers: Alice Laptop, Alice Phone')).toBeTruthy()
  })
})

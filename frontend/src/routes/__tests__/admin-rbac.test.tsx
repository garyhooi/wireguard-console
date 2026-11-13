// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../../lib/api', () => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
}))
vi.mock('../../lib/mfaClient', () => ({
  getMFAStatus: vi.fn(),
  startPasskeyStepUp: vi.fn(),
}))

import { apiJson } from '../../lib/api'
import type { ApiFetchOptions } from '../../lib/api'
import { AdminsPage } from '../_authenticated/admins'

const apiJsonMock = vi.mocked(apiJson)

const me = {
  id: 'admin-me',
  email: 'me@example.com',
  role: 'super_admin',
  role_name: 'Super admin',
  is_super_admin: true,
  permissions: ['*'],
  passkey_available: false,
  passkey_count: 0,
}

const admins = [
  {
    id: 'admin-me',
    email: 'me@example.com',
    role: 'super_admin',
    role_name: 'Super admin',
    totp_enabled: true,
    mfa_enabled: true,
    mfa_methods: ['totp'],
    passkey_count: 0,
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
    groups: [],
  },
  {
    id: 'admin-other',
    email: 'other@example.com',
    role: 'admin',
    role_name: 'Admin',
    totp_enabled: true,
    mfa_enabled: true,
    mfa_methods: ['totp'],
    passkey_count: 0,
    status: 'active',
    created_at: '2026-01-02T00:00:00Z',
    groups: [{ id: 'g1', name: 'Operators' }],
  },
]

const permissionNetworkView = {
  key: 'network.view',
  label: 'View network',
  description: 'See servers and peers.',
  group: 'network',
  reserved: false,
}
const permissionNetworkManage = {
  key: 'network.manage',
  label: 'Manage network',
  description: 'Add, edit and remove servers and peers.',
  group: 'network',
  reserved: false,
}
const permissionAdminsView = {
  key: 'admins.view',
  label: 'View admins',
  description: 'See admin accounts.',
  group: 'access',
  reserved: true,
}

const roles = [
  {
    slug: 'super_admin',
    name: 'Super admin',
    description: 'Full access.',
    permissions: ['*'],
    is_system: true,
    admin_count: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    slug: 'admin',
    name: 'Admin',
    description: 'Operations.',
    permissions: ['network.view', 'network.manage'],
    is_system: false,
    admin_count: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    slug: 'auditor',
    name: 'Auditor',
    description: 'Read only.',
    permissions: ['network.view'],
    is_system: false,
    admin_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
]

const catalog = {
  roles,
  permissions: [permissionNetworkView, permissionNetworkManage, permissionAdminsView],
  groups: [
    { key: 'network', label: 'Network', permissions: [permissionNetworkView, permissionNetworkManage] },
    { key: 'access', label: 'Access control', permissions: [permissionAdminsView] },
  ],
  defaults: {
    super_admin: ['*'],
    admin: ['network.view', 'network.manage'],
    auditor: ['network.view'],
  },
}

const groups = [
  {
    id: 'g1',
    name: 'Operators',
    description: 'Network team',
    member_count: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
]

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <AdminsPage />
    </QueryClientProvider>,
  )
}

function callsTo(path: string, method: string) {
  return apiJsonMock.mock.calls.filter(
    ([calledPath, options]) =>
      calledPath === path && (options?.method ?? 'GET').toUpperCase() === method,
  )
}

async function submitStepUpCode(code = '123456') {
  await waitFor(() => expect(screen.getAllByRole('dialog').length).toBeGreaterThan(1))
  const dialogs = screen.getAllByRole('dialog')
  const dialog = dialogs[dialogs.length - 1]
  fireEvent.change(within(dialog).getByLabelText('Authenticator or recovery code'), {
    target: { value: code },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))
}

describe('Admins → roles and groups', () => {
  beforeEach(() => {
    apiJsonMock.mockReset()
    apiJsonMock.mockImplementation(async (path: string, options?: ApiFetchOptions) => {
      const method = (options?.method ?? 'GET').toUpperCase()
      if (path === '/api/config/step-up' && method === 'GET') return { step_up_minutes: 0 }
      if (path === '/api/admins/me' && method === 'GET') return me
      if (path === '/api/admins' && method === 'GET') return admins
      if (path === '/api/admin-roles' && method === 'GET') return catalog
      if (path === '/api/admin-groups' && method === 'GET') return groups
      if (path === '/api/admin-roles' && method === 'POST') {
        return {
          ...roles[1],
          slug: 'network_operator',
          name: 'Network operator',
          description: '',
          permissions: ['network.view'],
          is_system: false,
          admin_count: 0,
        }
      }
      if (path === '/api/admin-groups' && method === 'POST') {
        return { ...groups[0], id: 'g2', name: 'New group', description: '' }
      }
      if (path === '/api/admin-groups/g1/assign-role' && method === 'POST') {
        return { status: 'updated', updated: 1 }
      }
      throw new Error(`unexpected apiJson call: ${method} ${path}`)
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('creates a custom role with the selected policy after an MFA step-up', async () => {
    renderPage()
    await screen.findByText('other@example.com')

    fireEvent.click(screen.getByRole('button', { name: 'Roles & policies' }))
    await screen.findByRole('button', { name: 'New role' })
    fireEvent.click(screen.getByRole('button', { name: 'New role' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Network operator' },
    })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /View network/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create role' }))

    await submitStepUpCode()

    await waitFor(() => expect(callsTo('/api/admin-roles', 'POST')).toHaveLength(1))
    expect(callsTo('/api/admin-roles', 'POST')[0][1]?.body).toEqual({
      name: 'Network operator',
      description: '',
      permissions: ['network.view'],
      code: '123456',
    })
  })

  it('creates an admin group without a step-up and shows it in the table', async () => {
    renderPage()
    await screen.findByText('other@example.com')

    fireEvent.click(screen.getByRole('button', { name: 'Admin groups' }))
    await screen.findByText('Operators')
    fireEvent.click(screen.getByRole('button', { name: 'New group' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'New group' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save group' }))

    await waitFor(() => expect(callsTo('/api/admin-groups', 'POST')).toHaveLength(1))
    expect(callsTo('/api/admin-groups', 'POST')[0][1]?.body).toEqual({
      name: 'New group',
      description: '',
    })
  })



  it('lets a custom role select sensitive capabilities', async () => {
    renderPage()
    await screen.findByText('other@example.com')

    fireEvent.click(screen.getByRole('button', { name: 'Roles & policies' }))
    await screen.findByRole('button', { name: 'New role' })
    fireEvent.click(screen.getByRole('button', { name: 'New role' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Access operator' },
    })
    const sensitive = within(dialog).getByRole('checkbox', { name: /View admins \(sensitive\)/ })
    expect((sensitive as HTMLInputElement).disabled).toBe(false)
    fireEvent.click(sensitive)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create role' }))

    await submitStepUpCode()
    await waitFor(() => expect(callsTo('/api/admin-roles', 'POST')).toHaveLength(1))
    expect(callsTo('/api/admin-roles', 'POST')[0][1]?.body).toEqual({
      name: 'Access operator',
      description: '',
      permissions: ['admins.view'],
      code: '123456',
    })
  })

  it('shows delete for seeded Admin and Auditor roles, while super_admin stays locked', async () => {
    renderPage()
    await screen.findByText('other@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Roles & policies' }))
    await screen.findByRole('button', { name: 'Delete role Auditor' })

    expect((screen.getByRole('button', { name: 'Delete role Admin' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Delete role Auditor' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole('button', { name: 'Delete role Super admin' })).toBeNull()
  })


  it('shows only the roles workspace to a roles.manage-only custom role', async () => {
    const roleManager = {
      ...me,
      id: 'role-manager',
      email: 'roles@example.com',
      role: 'role_manager',
      role_name: 'Role manager',
      is_super_admin: false,
      permissions: ['roles.manage'],
    }
    apiJsonMock.mockImplementation(async (path: string, options?: ApiFetchOptions) => {
      const method = (options?.method ?? 'GET').toUpperCase()
      if (path === '/api/config/step-up' && method === 'GET') return { step_up_minutes: 0 }
      if (path === '/api/admins/me' && method === 'GET') return roleManager
      if (path === '/api/admin-roles' && method === 'GET') return catalog
      throw new Error(`unexpected apiJson call: ${method} ${path}`)
    })

    renderPage()
    await screen.findByRole('button', { name: 'Roles & policies' })
    await screen.findByRole('button', { name: 'New role' })

    expect(screen.queryByRole('button', { name: 'Admins' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Admin groups' })).toBeNull()
    expect(callsTo('/api/admins', 'GET')).toHaveLength(0)
    expect(callsTo('/api/admin-groups', 'GET')).toHaveLength(0)
  })

  it('bulk-assigns a role to a group through the MFA gate', async () => {
    renderPage()
    await screen.findByText('other@example.com')

    fireEvent.click(screen.getByRole('button', { name: 'Admin groups' }))
    await screen.findByText('Operators')
    fireEvent.click(screen.getByRole('button', { name: 'Assign role to Operators' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Role'), {
      target: { value: 'auditor' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign role' }))
    await submitStepUpCode()

    await waitFor(() => expect(callsTo('/api/admin-groups/g1/assign-role', 'POST')).toHaveLength(1))
    expect(callsTo('/api/admin-groups/g1/assign-role', 'POST')[0][1]?.body).toEqual({
      role: 'auditor',
      code: '123456',
    })
  })
})
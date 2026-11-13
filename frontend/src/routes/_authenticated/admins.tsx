import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { IconKey, IconMailPlus, IconShieldOff, IconUserPlus } from '@tabler/icons-react'
import {
  Badge,
  EmptyState,
  GhostButton,
  Modal,
  PageHeader,
  PrimaryButton,
  Skeleton,
  StatusBadge,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
  toolbarCls,
  tabGroupCls,
  toolbarTab,
  searchCls,
  inputCls,
  labelCls,
} from '../../lib/ui'
import { ConfirmMFA } from '../../lib/ConfirmMFA'
import { apiJson } from '../../lib/api'
import { isMFAError, useStepUpMinutes } from '../../lib/stepup'
import { fmtDate } from '../../lib/timezone'
import { AdminGroupsTab } from '../../components/AdminGroupsTab'
import { AdminRolesTab } from '../../components/AdminRolesTab'
import { getGroups, getRoles, type AdminGroup, type RoleCatalog } from '../../lib/admin-rbac'
import { can, type AdminGroupRef } from '../../lib/permissions'

interface Admin {
  id: string
  email: string
  role: string
  role_name?: string
  groups?: AdminGroupRef[]
  /** Kept for compatibility with older payloads; prefer mfa_enabled. */
  totp_enabled: boolean
  mfa_enabled: boolean
  mfa_methods: string[]
  passkey_count: number
  status: string
  created_at: string
}

interface Me {
  id: string
  email: string
  role: string
  role_name?: string
  is_super_admin?: boolean
  permissions?: string[]
  groups?: AdminGroupRef[]
  passkey_available?: boolean
  passkey_count?: number
}

export const Route = createFileRoute('/_authenticated/admins')({
  component: AdminsPage,
})


/** A pending privileged action awaiting the admin's own MFA step-up. */
interface PendingMFA {
  label: string
  run: (code: string) => Promise<void>
}

/**
 * Inline confirmation for an email change that will reset the target's
 * passkeys. Saving alone must never delete passkeys — the changer sees the
 * warning, then explicitly confirms here before the MFA step-up runs.
 */
interface EmailPasskeyConfirm {
  adminId: string
  /** New email awaiting confirmation. */
  email: string
  passkeyCount: number
}

/** "1 passkey" / "3 passkeys". */
function passkeyCountLabel(count: number): string {
  return `${count} passkey${count === 1 ? '' : 's'}`
}

/** The passkey-reset warning shown while editing / in the confirm panel. */
function emailPasskeyWarning(count: number, isSelf: boolean): string {
  const passkeys = passkeyCountLabel(count)
  return isSelf
    ? `Saving resets your ${passkeys}. Add a new passkey in Profile afterwards; authenticator app and recovery codes keep working.`
    : `Saving resets this admin's ${passkeys}. They'll need to add a new passkey after this; authenticator app and recovery codes keep working.`
}

/**
 * Detect the server's defensive 409 for an email change that would reset
 * passkeys (the row's passkey_count may be stale). Returns the count from the
 * error envelope, or null when this is a different failure.
 */
function passkeysWillResetCount(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const e = err as { code?: unknown; body?: unknown }
  const body = (e.body && typeof e.body === 'object' ? e.body : {}) as {
    code?: unknown
    passkey_count?: unknown
  }
  const code = typeof e.code === 'string' ? e.code : body.code
  if (code !== 'passkeys_will_reset') return null
  const raw = body.passkey_count
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1
}

export function AdminsPage() {
  const queryClient = useQueryClient()
  const [section, setSection] = useState<'admins' | 'groups' | 'roles'>('admins')
  const [showInvite, setShowInvite] = useState(false)
  const [form, setForm] = useState({ email: '', role: 'admin', group_ids: [] as string[] })
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [groupFilter, setGroupFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState('')
  // Inline email editing state: one editor open at a time.
  const [editingId, setEditingId] = useState('')
  const [draftEmail, setDraftEmail] = useState('')
  // Explicit passkey-reset confirmation for the email change being edited.
  const [emailConfirm, setEmailConfirm] = useState<EmailPasskeyConfirm | null>(null)
  // Step-up MFA gate for privileged actions.
  const [pendingMFA, setPendingMFA] = useState<PendingMFA | null>(null)

  // MFA step-up grace: try the action without a code first — the server
  // accepts it when this session already verified within the window (or a
  // fresh passkey step-up stamped it). Only when the server answers with an
  // MFA step-up error do we open the confirmation modal.
  const stepUpMinutes = useStepUpMinutes()
  const gateMFA = (label: string, run: (code: string) => Promise<void>) => {
    if (stepUpMinutes <= 0) {
      setPendingMFA({ label, run }) // grace off — ask immediately
      return
    }
    run('').catch((e) => {
      if (isMFAError(e)) {
        setPendingMFA({ label, run })
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  }

  const { data: me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: async () => {
      return apiJson<Me>('/api/admins/me')
    },
  })

  const canViewAdmins = can(me, 'admins.view') || can(me, 'admins.manage')
  const canManageAdmins = can(me, 'admins.manage')
  const canManageRoles = can(me, 'roles.manage')
  const canViewRoles = canViewAdmins || canManageRoles

  useEffect(() => {
    if (!me) return
    if (!canViewAdmins && canViewRoles) setSection('roles')
  }, [me, canViewAdmins, canViewRoles])

  const { data: roles } = useQuery<RoleCatalog>({
    queryKey: ['admin-roles'],
    queryFn: getRoles,
    enabled: Boolean(me && canViewRoles),
  })

  const { data: adminGroups } = useQuery<AdminGroup[]>({
    queryKey: ['admin-groups'],
    queryFn: getGroups,
    enabled: Boolean(me && canViewAdmins),
  })

  const roleName = (slug: string) => roles?.roles.find((r) => r.slug === slug)?.name || slug

  const { data: admins, isLoading } = useQuery<Admin[]>({
    queryKey: ['admins'],
    queryFn: async () => {
      try {
        return await apiJson<Admin[]>('/api/admins')
      } catch (e) {
        const err = e as { status?: number }
        if (err.status === 403) throw new Error('You do not have permission to view admins')
        throw new Error('Failed to fetch admins')
      }
    },
    enabled: Boolean(me && canViewAdmins),
  })

  const openInvite = () => {
    const available = roles?.roles || []
    const preferred = available.find((r) => r.slug === 'admin')?.slug || available[0]?.slug || ''
    setForm((current) => ({ ...current, role: preferred || current.role }))
    setShowInvite(true)
  }

  const inviteMutation = useMutation({
    mutationFn: async () => {
      try {
        await apiJson('/api/admins', { method: 'POST', body: form })
      } catch (e) {
        throw new Error((e as Error).message || 'Failed to invite admin')
      }
    },
    onSuccess: () => {
      setShowInvite(false)
      setForm({ email: '', role: 'admin', group_ids: [] })
      setNotice(
        'Admin invited — initial credentials are emailed when SMTP is configured. If the email fails or is lost, use Resend credentials on the row to rotate to a new temporary password.',
      )
      setError('')
      queryClient.invalidateQueries({ queryKey: ['admins'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  // ---- Privileged admin mutations (each requires the actor's own MFA) ----

  const patchAdmin = async (id: string, body: Record<string, unknown>): Promise<unknown> => {
    try {
      return await apiJson(`/api/admins/${id}`, { method: 'PATCH', body })
    } catch (e) {
      // Preserve the machine-readable envelope: the email-change flow needs
      // code "passkeys_will_reset" and body.passkey_count to show the inline
      // passkey-reset confirmation instead of a transient error.
      const err = e as { message?: string; code?: string; status?: number; body?: unknown }
      const wrapped = new Error(err.message || 'Failed to update admin') as Error & {
        code?: string
        status?: number
        body?: unknown
      }
      if (err.code) wrapped.code = err.code
      if (err.status !== undefined) wrapped.status = err.status
      if (err.body !== undefined) wrapped.body = err.body
      throw wrapped
    }
  }

  const roleMutation = useMutation({
    mutationFn: async (a: { id: string; role: string; code: string }) =>
      patchAdmin(a.id, { role: a.role, code: a.code }),
    onSuccess: () => {
      setNotice('Role updated.')
      setError('')
      queryClient.invalidateQueries({ queryKey: ['admins'] })
      queryClient.invalidateQueries({ queryKey: ['admin-roles'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const resetPwMutation = useMutation({
    mutationFn: async (a: { admin: Admin; code: string }) => {
      try {
        return await apiJson(`/api/admins/${a.admin.id}/reset-password`, {
          method: 'POST',
          body: { code: a.code },
        })
      } catch (e) {
        throw new Error((e as Error).message || 'Failed to reset password')
      }
    },
    onSuccess: (data, vars) => {
      const pw = (data as { password?: string } | undefined)?.password
      setNotice(
        `New temporary password for ${vars.admin.email}: ${pw}  (emailed — re-sent when the earlier email hit an SMTP error)`,
      )
      setError('')
      queryClient.invalidateQueries({ queryKey: ['admins'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const resetMFAMutation = useMutation({
    mutationFn: async (a: { admin: Admin; code: string }) => {
      try {
        await apiJson(`/api/admins/${a.admin.id}/reset-mfa`, {
          method: 'POST',
          body: { code: a.code },
        })
      } catch (e) {
        throw new Error((e as Error).message || 'Failed to reset MFA')
      }
    },
    onSuccess: (_d, vars) => {
      setNotice(
        `MFA for ${vars.admin.email} has been reset — their passkeys, authenticator app and recovery codes are gone, all their sessions were signed out, and they will set up MFA again at their next sign-in.`,
      )
      setError('')
      queryClient.invalidateQueries({ queryKey: ['admins'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const emailMutation = useMutation({
    mutationFn: async (a: {
      admin: Admin
      email: string
      code: string
      resetPasskeys?: boolean
    }) => {
      const body: Record<string, unknown> = { email: a.email, code: a.code }
      if (a.resetPasskeys) body.reset_passkeys = true
      const data = (await patchAdmin(a.admin.id, body)) as
        | { passkeys_reset?: boolean; passkey_count?: number }
        | undefined
      return data ?? {}
    },
    onSuccess: (data, a) => {
      const isSelf = me?.id === a.admin.id
      setEditingId('')
      setDraftEmail('')
      setEmailConfirm(null)
      if (data.passkeys_reset) {
        const count = data.passkey_count ?? 1
        setNotice(
          isSelf
            ? 'Your email was updated and your passkeys were reset — add a new passkey in Profile.'
            : `Email updated and ${passkeyCountLabel(count)} reset — ${a.email} will need to add a new passkey.`,
        )
      } else {
        setNotice(
          isSelf
            ? 'Your email was updated. Use the new address to sign in from now on.'
            : 'Email updated.',
        )
      }
      setError('')
      queryClient.invalidateQueries({ queryKey: ['admins'] })
      queryClient.invalidateQueries({ queryKey: ['me'] })
    },
    onError: (e: Error, a) => {
      // Defensive: the row's passkey_count was stale. The server says how many
      // passkeys this email change would reset — reopen the row and surface the
      // explicit inline confirmation (nothing was written, no MFA was consumed).
      const count = passkeysWillResetCount(e)
      if (count !== null) {
        setPendingMFA(null)
        setEditingId(a.admin.id)
        setDraftEmail(a.email)
        setEmailConfirm({ adminId: a.admin.id, email: a.email, passkeyCount: count })
        setError('')
        setNotice('')
        return
      }
      setError(e.message)
    },
  })

  const statusMutation = useMutation({
    mutationFn: async (a: { admin: Admin; code: string }) =>
      patchAdmin(a.admin.id, {
        role: a.admin.role,
        status: a.admin.status === 'active' ? 'disabled' : 'active',
        code: a.code,
      }),
    onSuccess: () => {
      setNotice('Admin status updated.')
      setError('')
      queryClient.invalidateQueries({ queryKey: ['admins'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  // ---- MFA step-up wrappers: open the modal, run on confirm ----

  // Re-sending an admin's credentials email rotates to a fresh temporary
  // password (the original is never stored — only its hash — so it cannot
  // be re-emailed verbatim). This is the same reset-password flow below;
  // the acting super_admin confirms with their own MFA step-up.
  const confirmResetPassword = (admin: Admin) => {
    gateMFA(`reset the password for ${admin.email}`, (code) =>
      resetPwMutation.mutateAsync({ admin, code }).then(() => undefined),
    )
  }

  const confirmResetMFA = (admin: Admin) => {
    gateMFA(`reset MFA for ${admin.email}`, (code) =>
      resetMFAMutation.mutateAsync({ admin, code }).then(() => undefined),
    )
  }

  const confirmRoleChange = (admin: Admin, role: string) => {
    if (admin.role === role) return
    gateMFA(`change ${admin.email}'s role to ${roleName(role)}`, (code) =>
      roleMutation.mutateAsync({ id: admin.id, role, code }).then(() => undefined),
    )
  }

  const confirmStatusToggle = (admin: Admin) => {
    const next = admin.status === 'active' ? 'disable' : 'enable'
    gateMFA(`${next} admin ${admin.email}`, (code) =>
      statusMutation.mutateAsync({ admin, code }).then(() => undefined),
    )
  }

  const cancelEmailEdit = () => {
    setEditingId('')
    setDraftEmail('')
    setEmailConfirm(null)
  }

  const beginEmailEdit = (admin: Admin) => {
    setEditingId(admin.id)
    setDraftEmail(admin.email)
    setEmailConfirm(null)
    setError('')
  }

  /** True while the editor holds a different (non-empty) email. */
  const emailDraftChanged = (admin: Admin) => {
    const email = draftEmail.trim()
    return email !== '' && email !== admin.email
  }

  /**
   * Run the PATCH behind the MFA step-up gate. Shared by the plain path and
   * the post-confirmation passkey-reset path so both honour the grace window
   * and the passkey-first ConfirmMFA modal identically.
   */
  const saveEmailChange = (admin: Admin, email: string, resetPasskeys: boolean, label: string) => {
    const run = (code: string) =>
      emailMutation
        .mutateAsync({ admin, email, code, resetPasskeys })
        .then(() => undefined)
        .catch((e) => {
          // The mutation's onError already reopened the inline confirmation;
          // don't also surface a transient page/modal error.
          if (passkeysWillResetCount(e) !== null) return
          throw e
        })
    if (stepUpMinutes <= 0) {
      setPendingMFA({ label, run }) // grace off — ask immediately
      return
    }
    run('').catch((e) => {
      if (passkeysWillResetCount(e) !== null) return
      if (isMFAError(e)) {
        setPendingMFA({ label, run })
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  }

  const commitEmailEdit = (admin: Admin) => {
    const email = draftEmail.trim()
    if (!email || email === admin.email) {
      cancelEmailEdit()
      return
    }
    if (admin.passkey_count > 0) {
      // Saving must never silently delete bound passkeys: show the explicit
      // inline confirmation first. The API is only called from there.
      setEmailConfirm({ adminId: admin.id, email, passkeyCount: admin.passkey_count })
      return
    }
    // No passkeys: today's behavior — straight to the MFA step-up gate.
    saveEmailChange(admin, email, false, `change ${admin.email}'s email to ${email}`)
    setEditingId('')
  }

  /** Explicit "Reset passkeys & save" click: step-up gate + reset flag. */
  const confirmEmailPasskeyReset = (admin: Admin) => {
    const pending = emailConfirm
    if (!pending || pending.adminId !== admin.id) return
    const email = pending.email
    const isSelf = me?.id === admin.id
    setEmailConfirm(null)
    saveEmailChange(
      admin,
      email,
      true,
      isSelf
        ? `change your email to ${email} and reset your passkeys`
        : `change ${admin.email}'s email to ${email} and reset their passkeys`,
    )
  }

  const filtered = (admins || []).filter((a) => {
    if (statusFilter !== 'all' && a.status !== statusFilter) return false
    if (groupFilter !== 'all' && !(a.groups || []).some((g) => g.id === groupFilter)) return false
    const q = search.trim().toLowerCase()
    if (!q) return true
    return (a.email || '').toLowerCase().includes(q)
  })
  const statusCounts = (admins || []).reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] || 0) + 1
    return acc
  }, {})
  const TABS = ['all', 'active', 'disabled']

  if (me && !canViewAdmins && !canViewRoles) {
    return (
      <div>
        <PageHeader title="Admins" description="Access control requires the admins.view or roles.manage capability." />
        <p className="text-sm text-zinc-400">You do not have permission to view admins or roles.</p>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Admins & access"
        description="People who operate this console, their roles and their admin groups. VPN users live under VPN Users and only receive tunnel configs."
        actions={section === 'admins' && canManageAdmins ? (
          <PrimaryButton onClick={openInvite} disabled={!roles?.roles.length}>
            <IconUserPlus size={16} stroke={1.6} aria-hidden="true" />
            Invite Admin
          </PrimaryButton>
        ) : undefined}
      />

      <div className="mb-6 border-b border-zinc-800">
        <nav className="-mb-px flex gap-6" aria-label="Admin access sections">
          {[
            canViewAdmins ? ['admins', 'Admins'] : null,
            canViewAdmins ? ['groups', 'Admin groups'] : null,
            canViewRoles ? ['roles', 'Roles & policies'] : null,
          ].filter((item): item is [string, string] => item !== null).map(([key, label]) => (
            <button
              key={key}
              onClick={() => {
                setSection(key as 'admins' | 'groups' | 'roles')
                setError('')
                setNotice('')
              }}
              aria-current={section === key ? 'page' : undefined}
              className={`border-b-2 px-1 pb-2.5 text-sm transition-colors ${section === key ? 'border-teal-500 text-teal-400' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
      {notice && <p className="text-teal-400 text-sm mb-3">{notice}</p>}

      {section === 'groups' && canViewAdmins && <AdminGroupsTab gateMFA={gateMFA} canManage={canManageAdmins} />}
      {section === 'roles' && canViewRoles && <AdminRolesTab gateMFA={gateMFA} canManage={canManageRoles} />}

      <Modal
        open={showInvite}
        onClose={() => setShowInvite(false)}
        title="Invite Admin"
        className="max-w-md"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            inviteMutation.mutate()
          }}
          className="space-y-4"
        >
          <div>
            <label className={labelCls}>Email</label>
            <input
              type="email"
              required
              className={inputCls}
              placeholder="operator@company.com"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </div>
          <div>
            <label className={labelCls}>Role</label>
            <select className={inputCls} value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
              {(roles?.roles || [{ slug: 'admin', name: 'Admin' }]).map((role) => (
                <option key={role.slug} value={role.slug}>{role.name}{'is_system' in role && role.is_system ? ' (system)' : ''}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Admin groups</label>
            <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-zinc-800 p-2">
              {(adminGroups || []).length === 0 ? (
                <p className="text-xs text-zinc-500">No groups yet. Create one in the Admin groups tab.</p>
              ) : (adminGroups || []).map((group) => (
                <label key={group.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800/50">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-teal-500"
                    checked={form.group_ids.includes(group.id)}
                    onChange={(e) => setForm((current) => ({
                      ...current,
                      group_ids: e.target.checked
                        ? [...current.group_ids, group.id]
                        : current.group_ids.filter((id) => id !== group.id),
                    }))}
                  />
                  {group.name}
                </label>
              ))}
            </div>
          </div>
          <p className="text-xs text-zinc-500">
            The invited admin receives temporary credentials by email and must change them in
            Profile on first login (multi-factor authentication is enforced).
          </p>
          <div className="flex justify-end gap-3 pt-2">
            <GhostButton onClick={() => setShowInvite(false)}>Cancel</GhostButton>
            <PrimaryButton type="submit" disabled={inviteMutation.isPending}>
              {inviteMutation.isPending ? 'Inviting…' : 'Send Invite'}
            </PrimaryButton>
          </div>
        </form>
      </Modal>

      {section === 'admins' && canViewAdmins && (
      <>
      <div className={toolbarCls}>
        <div className={tabGroupCls}>
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setStatusFilter(tab)}
              className={toolbarTab(statusFilter === tab, 'bg-zinc-700 text-white')}
            >
              {tab === 'all' ? 'All' : tab[0].toUpperCase() + tab.slice(1)}
              <span className="ml-1 text-zinc-500">
                {tab === 'all' ? admins?.length ?? 0 : statusCounts[tab] || 0}
              </span>
            </button>
          ))}
        </div>
        <select
          className="rounded-md border border-zinc-700 bg-zinc-800/60 px-2 py-1.5 text-xs text-zinc-300 focus:outline-none focus:ring-2 focus:ring-teal-500"
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          aria-label="Filter by admin group"
        >
          <option value="all">All groups</option>
          {(adminGroups || []).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
        <input
          type="search"
          placeholder="Search email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={searchCls}
        />
        <span className="text-xs text-zinc-500">{filtered.length} shown</span>
      </div>

      <div className={tableWrapCls}>
        {isLoading ? (
          <div className="p-5 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState title="No admins match this filter" hint="Adjust the filter or invite a new admin." />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 bg-zinc-800/40">
                  <th className={thCls}>Email</th>
                  <th className={thCls}>Role</th>
                  <th className={thCls}>Groups</th>
                  <th className={thCls}>MFA</th>
                  <th className={thCls}>Status</th>
                  <th className={thCls}>Created</th>
                  <th className={thCls + ' text-right'}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {filtered.map((a) => {
                  const rowIsSelf = me?.id === a.id
                  const rowConfirming = emailConfirm?.adminId === a.id
                  // The warning shows while a changed draft would reset
                  // passkeys on save. While the explicit confirmation is open
                  // the panel carries the same copy (avoid duplicate text).
                  const rowWarning =
                    editingId === a.id && emailDraftChanged(a) && a.passkey_count > 0
                      ? emailPasskeyWarning(a.passkey_count, rowIsSelf)
                      : ''
                  return (
                  <tr key={a.id} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="px-5 py-3 text-sm">
                      {editingId === a.id ? (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <input
                              type="email"
                              autoFocus
                              required
                              className="w-56 bg-zinc-800/60 border border-zinc-700 rounded-md px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-teal-500"
                              value={draftEmail}
                              onChange={(e) => {
                                setDraftEmail(e.target.value)
                                // Editing again supersedes the pending
                                // confirmation (it was for the old draft).
                                if (rowConfirming) setEmailConfirm(null)
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && draftEmail.trim()) {
                                  commitEmailEdit(a)
                                } else if (e.key === 'Escape') {
                                  cancelEmailEdit()
                                }
                              }}
                            />
                            <button
                              onClick={() => commitEmailEdit(a)}
                              disabled={!draftEmail.trim() || emailMutation.isPending}
                              className="text-teal-400 hover:text-teal-300 disabled:opacity-40"
                              aria-label="Save email"
                            >
                              Save
                            </button>
                            <button
                              onClick={cancelEmailEdit}
                              className="text-zinc-500 hover:text-zinc-300"
                              aria-label="Cancel edit"
                            >
                              Cancel
                            </button>
                          </div>
                          {rowWarning && !rowConfirming && (
                            <p
                              data-testid="passkey-reset-warning"
                              className="max-w-xs text-xs leading-relaxed text-amber-400/90"
                            >
                              {rowWarning}
                            </p>
                          )}
                          {rowConfirming && emailConfirm && (
                            <div
                              data-testid="passkey-reset-confirm"
                              role="group"
                              aria-label="Reset passkeys and change email?"
                              className="max-w-xs space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5"
                            >
                              <p className="text-xs font-medium text-amber-300">
                                Reset passkeys and change email?
                              </p>
                              <p className="text-xs leading-relaxed text-amber-200/80">
                                {rowWarning ||
                                  emailPasskeyWarning(emailConfirm.passkeyCount, rowIsSelf)}
                              </p>
                              <p className="text-xs text-amber-200/80">
                                {rowIsSelf
                                  ? 'Your other sessions will be signed out.'
                                  : 'Their other sessions will be signed out.'}
                              </p>
                              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                                <PrimaryButton
                                  onClick={() => confirmEmailPasskeyReset(a)}
                                  className="!px-3 !py-1.5 !text-xs"
                                >
                                  Reset passkeys &amp; save
                                </PrimaryButton>
                                <GhostButton
                                  onClick={() => setEmailConfirm(null)}
                                  className="!px-3 !py-1.5 !text-xs"
                                >
                                  Cancel
                                </GhostButton>
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="flex items-center gap-2 text-zinc-200">
                          {a.email}
                          {me?.id === a.id && (
                            <Badge tone="accent" label="you">
                              You
                            </Badge>
                          )}
                          {a.status === 'active' && canManageAdmins && (
                            <button
                              onClick={() => beginEmailEdit(a)}
                              className="text-zinc-600 hover:text-teal-400 transition-colors"
                              aria-label={`Edit email for ${a.email}`}
                            >
                              Edit
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <select
                        className="bg-zinc-800/60 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-teal-500"
                        value={a.role}
                        disabled={me?.id === a.id || !canManageAdmins}
                        onChange={(e) => a.status === 'active' && canManageAdmins && confirmRoleChange(a, e.target.value)}
                      >
                        {(roles?.roles || [{ slug: a.role, name: a.role_name || a.role }]).map((role) => (
                          <option key={role.slug} value={role.slug}>{role.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-5 py-3">
                      {(a.groups || []).length === 0 ? (
                        <span className="text-xs text-zinc-600">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {(a.groups || []).map((group) => <Badge key={group.id} tone="neutral">{group.name}</Badge>)}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <Badge tone={(a.mfa_enabled ?? a.totp_enabled) ? 'good' : 'warn'}>
                          {(a.mfa_enabled ?? a.totp_enabled) ? 'enabled' : 'not set up'}
                        </Badge>
                        {(a.mfa_methods || []).length > 0 && (
                          <span className="text-xs text-zinc-600">
                            {(a.mfa_methods || [])
                              .map((m) => (m === 'totp' ? 'app' : m === 'recovery_code' ? 'codes' : m))
                              .join(' + ')}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={a.status} />
                    </td>
                    <td className={tdCls + ' font-mono tabular-nums'}>
                      {a.created_at ? fmtDate(a.created_at) : '—'}
                    </td>
                    <td className="px-5 py-3 text-right text-sm">
                      {canManageAdmins ? (
                      <div className="flex justify-end gap-1">
                        {a.status === 'active' ? (
                          <>
                            <button
                              onClick={() => {
                                if (confirm(`Resend credentials to "${a.email}"? A new temporary password will be generated, emailed (when SMTP is configured), and shown once. Their current password is invalidated — use this when the original credentials email failed or was lost.`))
                                  confirmResetPassword(a)
                              }}
                              className="inline-flex items-center gap-1 text-sm rounded-md px-2 py-1 text-teal-400 hover:text-teal-300 hover:bg-teal-500/10 transition-colors"
                            >
                              <IconKey size={13} stroke={1.6} aria-hidden="true" />
                              Resend credentials
                            </button>
                            {me?.id !== a.id && (a.mfa_enabled ?? a.totp_enabled) && (
                              <button
                                onClick={() => {
                                  if (confirm(`Reset MFA for "${a.email}"?\n\nTheir passkeys, authenticator app and recovery codes will be removed, and all of their sessions will be signed out. They will set up MFA again at their next sign-in. Use this when they have lost access to their factors.`))
                                    confirmResetMFA(a)
                                }}
                                className="inline-flex items-center gap-1 text-sm rounded-md px-2 py-1 text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 transition-colors"
                              >
                                <IconShieldOff size={13} stroke={1.6} aria-hidden="true" />
                                Reset MFA
                              </button>
                            )}
                            {me?.id !== a.id && (
                              <button
                                onClick={() => {
                                  if (confirm(`Disable admin "${a.email}"?`)) confirmStatusToggle(a)
                                }}
                                className="inline-flex items-center text-sm rounded-md px-2 py-1 text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                              >
                                Disable
                              </button>
                            )}
                          </>
                        ) : (
                          <button
                            onClick={() => confirmStatusToggle(a)}
                            className="inline-flex items-center text-sm rounded-md px-2 py-1 text-teal-400 hover:text-teal-300 hover:bg-teal-500/10 transition-colors"
                          >
                            Enable
                          </button>
                        )}
                      </div>
                      ) : (
                        <span className="text-xs text-zinc-600">View only</span>
                      )}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      </>
      )}

      {/* Step-up MFA gate for privileged admin actions */}
      <ConfirmMFA
        open={pendingMFA !== null}
        onClose={() => setPendingMFA(null)}
        title="Confirm with MFA"
        description={
          pendingMFA
            ? `Confirm this action with your passkey or an authenticator code to ${pendingMFA.label}. This extra confirmation protects the console from unauthorized account changes.`
            : undefined
        }
        onSubmit={pendingMFA ? pendingMFA.run : null}
        passkeyAvailable={Boolean(me?.passkey_available && (me?.passkey_count ?? 0) > 0)}
      />
    </div>
  )
}
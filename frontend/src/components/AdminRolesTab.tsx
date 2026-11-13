import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconLock, IconPencil, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react'
import {
  Badge,
  EmptyState,
  GhostButton,
  Modal,
  PrimaryButton,
  Skeleton,
  inputCls,
  labelCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
} from '../lib/ui'
import {
  createRole,
  deleteRole,
  getRoles,
  updateRole,
  type AdminRole,
  type PermissionGroup,
} from '../lib/admin-rbac'

interface Props {
  gateMFA: (label: string, run: (code: string) => Promise<void>) => void
  canManage: boolean
}

function permissionSummary(permissions: string[]): string {
  if (permissions.includes('*')) return 'Full access'
  if (permissions.length === 0) return 'No access'
  return `${permissions.length} capabilit${permissions.length === 1 ? 'y' : 'ies'}`
}

export function AdminRolesTab({ gateMFA, canManage }: Props) {
  const queryClient = useQueryClient()
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<AdminRole | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [permissions, setPermissions] = useState<string[]>([])

  const catalog = useQuery({ queryKey: ['admin-roles'], queryFn: getRoles })

  const saveMutation = useMutation({
    mutationFn: async (code: string) => {
      const body = { name: name.trim(), description: description.trim(), permissions, code }
      if (editing) return updateRole(editing.slug, body)
      return createRole(body)
    },
    onSuccess: (role) => {
      setNotice(editing ? `Role "${role.name}" updated. Existing admins now use the new policy.` : `Role "${role.name}" created.`)
      setError('')
      setFormOpen(false)
      setEditing(null)
      queryClient.invalidateQueries({ queryKey: ['admin-roles'] })
      queryClient.invalidateQueries({ queryKey: ['admins'] })
      queryClient.invalidateQueries({ queryKey: ['me'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const deleteMutation = useMutation({
    mutationFn: async ({ slug, code }: { slug: string; code: string }) => deleteRole(slug, code),
    onSuccess: () => {
      setNotice('Role deleted.')
      setError('')
      queryClient.invalidateQueries({ queryKey: ['admin-roles'] })
      queryClient.invalidateQueries({ queryKey: ['admins'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const openCreate = () => {
    setEditing(null)
    setName('')
    setDescription('')
    setPermissions([])
    setError('')
    setFormOpen(true)
  }

  const openEdit = (role: AdminRole) => {
    setEditing(role)
    setName(role.name)
    setDescription(role.description)
    setPermissions(role.permissions)
    setError('')
    setFormOpen(true)
  }

  const togglePermission = (key: string) => {
    setPermissions((current) => current.includes(key) ? current.filter((p) => p !== key) : [...current, key])
  }

  const toggleGroup = (group: PermissionGroup) => {
    const selectable = group.permissions.map((p) => p.key)
    const all = selectable.length > 0 && selectable.every((key) => permissions.includes(key))
    setPermissions((current) => all
      ? current.filter((key) => !selectable.includes(key))
      : [...new Set([...current, ...selectable])])
  }

  const save = () => {
    if (!name.trim()) return
    const label = editing ? `save the policy for ${editing.name}` : `create the role ${name.trim()}`
    gateMFA(label, async (code) => {
      await saveMutation.mutateAsync(code)
    })
  }

  const remove = (role: AdminRole) => {
    if (!confirm(`Delete the role "${role.name}"? This cannot be undone.`)) return
    gateMFA(`delete the role ${role.name}`, async (code) => {
      await deleteMutation.mutateAsync({ slug: role.slug, code })
    })
  }

  const resetDefaults = () => {
    if (!editing) return
    const defaults = catalog.data?.defaults?.[editing.slug]
    if (defaults) setPermissions(defaults.filter((p) => p !== '*'))
  }

  const locked = editing?.slug === 'super_admin' || !canManage
  const groups = catalog.data?.groups || []

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Roles &amp; policies</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-400">
            A role is a named permission policy. Each admin has one role. Editing the built-in
            Admin or Auditor role updates every admin assigned to it immediately.
          </p>
        </div>
        {canManage && (
          <PrimaryButton onClick={openCreate}>
            <IconPlus size={16} stroke={1.6} aria-hidden="true" />
            New role
          </PrimaryButton>
        )}
      </div>

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
      {notice && <p className="mt-4 text-sm text-teal-400">{notice}</p>}

      <div className={`mt-5 ${tableWrapCls}`}>
        {catalog.isLoading ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (catalog.data?.roles || []).length === 0 ? (
          <EmptyState title="No roles found" hint="Create a role to define a permission policy." />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                  <th className={thCls}>Role</th>
                  <th className={thCls}>Policy</th>
                  <th className={thCls}>Admins</th>
                  <th className={thCls + ' text-right'}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {(catalog.data?.roles || []).map((role) => {
                  const rowLocked = role.slug === 'super_admin'
                  return (
                  <tr key={role.slug} className="transition-colors hover:bg-zinc-800/30">
                    <td className={tdCls}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-zinc-200">{role.name}</span>
                        {role.is_system && <Badge tone="neutral">system</Badge>}
                        {role.slug === 'super_admin' && <IconLock size={13} className="text-zinc-500" aria-label="Locked policy" />}
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-zinc-600">{role.slug}</div>
                      {role.description && <div className="mt-1 text-xs text-zinc-500">{role.description}</div>}
                    </td>
                    <td className={tdCls + ' text-zinc-400'}>{permissionSummary(role.permissions)}</td>
                    <td className={tdCls}>
                      <Badge tone={role.admin_count > 0 ? 'accent' : 'neutral'}>{role.admin_count}</Badge>
                    </td>
                    <td className={tdCls + ' text-right'}>
                      <div className="flex flex-wrap justify-end gap-1">
                        <button
                          onClick={() => openEdit(role)}
                          aria-label={`${canManage ? 'Edit' : 'View'} role ${role.name}`}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-zinc-300 transition-colors hover:bg-zinc-700/50 hover:text-white"
                        >
                          <IconPencil size={13} stroke={1.6} aria-hidden="true" /> {rowLocked || !canManage ? 'View' : 'Edit'}
                        </button>
                        {canManage && !role.is_system && (
                          <button
                            disabled={role.admin_count > 0}
                            title={role.admin_count > 0 ? 'Reassign the admins using this role first' : 'Delete role'}
                            aria-label={`Delete role ${role.name}`}
                            onClick={() => remove(role)}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <IconTrash size={13} stroke={1.6} aria-hidden="true" /> Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-zinc-500">
        Sensitive capabilities (access control, security policy and maintenance) can be granted
        to custom roles. Only the super_admin wildcard is non-assignable and locked.
      </p>

      <Modal open={formOpen} onClose={() => setFormOpen(false)} title={editing ? (editing.slug === 'super_admin' ? 'Super admin policy' : `${canManage ? 'Edit' : 'View'} role: ${editing.name}`) : 'New role'} className="max-w-3xl">
        <div className="space-y-5">
          {locked && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-300">
              The super_admin policy is locked to full access so the console cannot lose its break-glass role.
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="role-name">Name</label>
              <input id="role-name" className={inputCls} maxLength={80} disabled={locked} value={name} onChange={(e) => setName(e.target.value)} placeholder="Network operator" />
            </div>
            <div>
              <label className={labelCls} htmlFor="role-description">Description</label>
              <input id="role-description" className={inputCls} maxLength={300} disabled={locked} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Runs servers and peers, no access control" />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-medium text-zinc-200">Permissions</h3>
              <p className="text-xs text-zinc-500">{permissions.includes('*') ? 'Full access' : `${permissions.length} selected`}</p>
            </div>
            {canManage && editing && (editing.slug === 'admin' || editing.slug === 'auditor') && (
              <GhostButton type="button" onClick={resetDefaults} className="!px-3 !py-1.5 !text-xs">
                <IconRefresh size={13} stroke={1.6} aria-hidden="true" /> Reset to defaults
              </GhostButton>
            )}
          </div>

          <div className="space-y-4">
            {groups.map((group) => {
              const selectable = group.permissions
              const selected = selectable.filter((p) => permissions.includes(p.key))
              const all = selectable.length > 0 && selected.length === selectable.length
              return (
                <div key={group.key} className="rounded-lg border border-zinc-800">
                  <div className="flex items-center justify-between gap-3 border-b border-zinc-800/80 px-4 py-2.5">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{group.label}</h4>
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-500">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-teal-500"
                        checked={editing?.slug === 'super_admin' || all}
                        disabled={locked}
                        onChange={() => toggleGroup(group)}
                      />
                      All
                    </label>
                  </div>
                  <div className="grid gap-2 p-3 sm:grid-cols-2">
                    {group.permissions.map((permission) => (
                      <label key={permission.key} className="flex cursor-pointer gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-zinc-800/50">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 shrink-0 accent-teal-500"
                          checked={editing?.slug === 'super_admin' || permissions.includes(permission.key)}
                          disabled={locked}
                          onChange={() => togglePermission(permission.key)}
                        />
                        <span>
                          <span className="block text-zinc-200">{permission.label}{permission.reserved ? ' (sensitive)' : ''}</span>
                          <span className="block text-[11px] leading-relaxed text-zinc-500">{permission.description}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="flex justify-end gap-3 border-t border-zinc-800 pt-4">
            <GhostButton type="button" onClick={() => setFormOpen(false)}>Cancel</GhostButton>
            {!locked && canManage && (
              <PrimaryButton type="button" disabled={saveMutation.isPending || !name.trim()} onClick={save}>
                {saveMutation.isPending ? 'Saving…' : editing ? 'Save policy' : 'Create role'}
              </PrimaryButton>
            )}
          </div>
        </div>
      </Modal>
    </div>
  )
}
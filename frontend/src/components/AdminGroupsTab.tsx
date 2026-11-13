import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconPencil, IconPlus, IconShieldCheck, IconTrash, IconUsers } from '@tabler/icons-react'
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
  assignGroupRole,
  createGroup,
  deleteGroup,
  getAdmins,
  getGroup,
  getGroups,
  getRoles,
  setGroupMembers,
  updateGroup,
  type AdminGroup,
  type AdminSummary,
} from '../lib/admin-rbac'

interface Props {
  gateMFA: (label: string, run: (code: string) => Promise<void>) => void
}

export function AdminGroupsTab({ gateMFA }: Props) {
  const queryClient = useQueryClient()
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<AdminGroup | null>(null)
  const [form, setForm] = useState({ name: '', description: '' })
  const [membersFor, setMembersFor] = useState<AdminGroup | null>(null)
  const [selectedMembers, setSelectedMembers] = useState<string[]>([])
  const [assignFor, setAssignFor] = useState<AdminGroup | null>(null)
  const [assignRoleSlug, setAssignRoleSlug] = useState('admin')

  const groups = useQuery({ queryKey: ['admin-groups'], queryFn: getGroups })
  const admins = useQuery({ queryKey: ['admins'], queryFn: getAdmins })
  const roles = useQuery({ queryKey: ['admin-roles'], queryFn: getRoles })
  const detail = useQuery({
    queryKey: ['admin-group', membersFor?.id],
    queryFn: () => getGroup(membersFor!.id),
    enabled: Boolean(membersFor),
  })

  useEffect(() => {
    if (detail.data && membersFor && detail.data.group.id === membersFor.id) {
      setSelectedMembers(detail.data.members.map((m) => m.id))
    }
  }, [detail.data, membersFor])

  const saveGroup = useMutation({
    mutationFn: async () => {
      const body = { name: form.name.trim(), description: form.description.trim() }
      if (editing) return updateGroup(editing.id, body)
      return createGroup(body)
    },
    onSuccess: () => {
      setNotice(editing ? 'Admin group updated.' : 'Admin group created.')
      setError('')
      setFormOpen(false)
      setEditing(null)
      setForm({ name: '', description: '' })
      queryClient.invalidateQueries({ queryKey: ['admin-groups'] })
      queryClient.invalidateQueries({ queryKey: ['admins'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const removeGroup = useMutation({
    mutationFn: (id: string) => deleteGroup(id),
    onSuccess: () => {
      setNotice('Admin group deleted. Admins were not removed.')
      setError('')
      queryClient.invalidateQueries({ queryKey: ['admin-groups'] })
      queryClient.invalidateQueries({ queryKey: ['admins'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const saveMembers = useMutation({
    mutationFn: () => setGroupMembers(membersFor!.id, selectedMembers),
    onSuccess: () => {
      setNotice('Group members updated.')
      setError('')
      setMembersFor(null)
      queryClient.invalidateQueries({ queryKey: ['admin-groups'] })
      queryClient.invalidateQueries({ queryKey: ['admins'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const openCreate = () => {
    setEditing(null)
    setForm({ name: '', description: '' })
    setError('')
    setFormOpen(true)
  }

  const openEdit = (group: AdminGroup) => {
    setEditing(group)
    setForm({ name: group.name, description: group.description })
    setError('')
    setFormOpen(true)
  }

  const openMembers = (group: AdminGroup) => {
    setMembersFor(group)
    setSelectedMembers([])
    setError('')
  }

  const openAssign = (group: AdminGroup) => {
    const preferred = roles.data?.roles.find((r) => !r.is_system)?.slug || 'admin'
    setAssignFor(group)
    setAssignRoleSlug(preferred)
    setError('')
  }

  const doAssign = () => {
    if (!assignFor) return
    const group = assignFor
    const role = assignRoleSlug
    const roleName = roles.data?.roles.find((r) => r.slug === role)?.name || role
    gateMFA(
      `assign the ${roleName} role to everyone in ${group.name}`,
      async (code) => {
        const res = await assignGroupRole(group.id, role, code)
        setNotice(`Updated ${res.updated} admin${res.updated === 1 ? '' : 's'} in ${group.name}.`)
        setError('')
        setAssignFor(null)
        queryClient.invalidateQueries({ queryKey: ['admins'] })
        queryClient.invalidateQueries({ queryKey: ['admin-groups'] })
        queryClient.invalidateQueries({ queryKey: ['admin-roles'] })
      },
    )
  }

  const adminRows: AdminSummary[] = admins.data || []
  const selectedCount = selectedMembers.length

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Admin groups</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-400">
            Groups are organizational. They filter the admin list and make bulk role changes
            easy; permissions still come from each admin's single role.
          </p>
        </div>
        <PrimaryButton onClick={openCreate}>
          <IconPlus size={16} stroke={1.6} aria-hidden="true" />
          New group
        </PrimaryButton>
      </div>

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
      {notice && <p className="mt-4 text-sm text-teal-400">{notice}</p>}

      <div className={`mt-5 ${tableWrapCls}`}>
        {groups.isLoading ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (groups.data || []).length === 0 ? (
          <EmptyState title="No admin groups yet" hint="Create a group to organize admins and apply a role to several people at once." />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                  <th className={thCls}>Group</th>
                  <th className={thCls}>Description</th>
                  <th className={thCls}>Members</th>
                  <th className={thCls + ' text-right'}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {(groups.data || []).map((group) => (
                  <tr key={group.id} className="transition-colors hover:bg-zinc-800/30">
                    <td className={tdCls + ' font-medium text-zinc-200'}>{group.name}</td>
                    <td className={tdCls + ' text-zinc-400'}>{group.description || '—'}</td>
                    <td className={tdCls}>
                      <Badge tone="neutral">{group.member_count} admin{group.member_count === 1 ? '' : 's'}</Badge>
                    </td>
                    <td className={tdCls + ' text-right'}>
                      <div className="flex flex-wrap justify-end gap-1">
                        <button onClick={() => openMembers(group)} aria-label={`Members of ${group.name}`} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-teal-400 transition-colors hover:bg-teal-500/10 hover:text-teal-300">
                          <IconUsers size={13} stroke={1.6} aria-hidden="true" /> Members
                        </button>
                        <button onClick={() => openAssign(group)} aria-label={`Assign role to ${group.name}`} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-amber-400 transition-colors hover:bg-amber-500/10 hover:text-amber-300">
                          <IconShieldCheck size={13} stroke={1.6} aria-hidden="true" /> Assign role
                        </button>
                        <button onClick={() => openEdit(group)} aria-label={`Edit ${group.name}`} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-zinc-300 transition-colors hover:bg-zinc-700/50 hover:text-white">
                          <IconPencil size={13} stroke={1.6} aria-hidden="true" /> Edit
                        </button>
                        <button onClick={() => { if (confirm(`Delete admin group "${group.name}"? Admins will not be deleted.`)) removeGroup.mutate(group.id) }} aria-label={`Delete ${group.name}`} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300">
                          <IconTrash size={13} stroke={1.6} aria-hidden="true" /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={formOpen} onClose={() => setFormOpen(false)} title={editing ? 'Edit admin group' : 'New admin group'} className="max-w-md">
        <form
          className="space-y-4"
          onSubmit={(e) => { e.preventDefault(); saveGroup.mutate() }}
        >
          <div>
            <label className={labelCls} htmlFor="admin-group-name">Name</label>
            <input id="admin-group-name" className={inputCls} required maxLength={80} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Network operators" />
          </div>
          <div>
            <label className={labelCls} htmlFor="admin-group-description">Description</label>
            <textarea id="admin-group-description" className={inputCls} rows={3} maxLength={300} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="Who belongs here and what they own" />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <GhostButton type="button" onClick={() => setFormOpen(false)}>Cancel</GhostButton>
            <PrimaryButton type="submit" disabled={saveGroup.isPending || !form.name.trim()}>{saveGroup.isPending ? 'Saving…' : 'Save group'}</PrimaryButton>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(membersFor)} onClose={() => setMembersFor(null)} title={membersFor ? `Members of ${membersFor.name}` : 'Group members'} className="max-w-xl">
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">Select the admins in this group. Membership does not change permissions.</p>
          {detail.isLoading ? (
            <div className="space-y-2"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /></div>
          ) : detail.isError ? (
            <p role="alert" className="text-sm text-red-400">Failed to load the current group members. Saving is disabled so an error cannot clear the group.</p>
          ) : adminRows.length === 0 ? (
            <p className="text-sm text-zinc-500">No admins found.</p>
          ) : (
            <div className="max-h-80 space-y-1 overflow-y-auto rounded-md border border-zinc-800 p-2">
              {adminRows.map((admin) => (
                <label key={admin.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-zinc-800/50">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-teal-500"
                    checked={selectedMembers.includes(admin.id)}
                    onChange={(e) => setSelectedMembers((current) => e.target.checked ? [...current, admin.id] : current.filter((id) => id !== admin.id))}
                  />
                  <span className="min-w-0 flex-1 truncate text-zinc-200">{admin.email}</span>
                  <span className="text-xs text-zinc-500">{admin.role_name || admin.role}</span>
                </label>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-zinc-500">{selectedCount} selected</span>
            <div className="flex gap-3">
              <GhostButton type="button" onClick={() => setMembersFor(null)}>Cancel</GhostButton>
              <PrimaryButton type="button" disabled={saveMembers.isPending || detail.isLoading || detail.isError} onClick={() => saveMembers.mutate()}>{saveMembers.isPending ? 'Saving…' : 'Save members'}</PrimaryButton>
            </div>
          </div>
        </div>
      </Modal>

      <Modal open={Boolean(assignFor)} onClose={() => setAssignFor(null)} title={assignFor ? `Assign a role to ${assignFor.name}` : 'Assign role'} className="max-w-md">
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-amber-300/90">This replaces the role of every admin in this group. It does not add or remove group members.</p>
          <div>
            <label className={labelCls} htmlFor="assign-group-role">Role</label>
            <select id="assign-group-role" className={inputCls} value={assignRoleSlug} onChange={(e) => setAssignRoleSlug(e.target.value)}>
              {(roles.data?.roles || []).map((role) => <option key={role.slug} value={role.slug}>{role.name}{role.is_system ? ' (system)' : ''}</option>)}
            </select>
          </div>
          <div className="flex justify-end gap-3">
            <GhostButton type="button" onClick={() => setAssignFor(null)}>Cancel</GhostButton>
            <PrimaryButton type="button" onClick={doAssign}>Assign role</PrimaryButton>
          </div>
        </div>
      </Modal>
    </div>
  )
}
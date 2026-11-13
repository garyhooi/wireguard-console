import { apiJson } from './api'
import type { AdminGroupRef } from './permissions'

export interface PermissionDef {
  key: string
  label: string
  description: string
  group: string
  reserved: boolean
}

export interface PermissionGroup {
  key: string
  label: string
  permissions: PermissionDef[]
}

export interface AdminRole {
  slug: string
  name: string
  description: string
  permissions: string[]
  is_system: boolean
  admin_count: number
  created_at: string
  updated_at: string
}

export interface RoleCatalog {
  roles: AdminRole[]
  permissions: PermissionDef[]
  groups: PermissionGroup[]
  defaults: Record<string, string[]>
}

export interface AdminGroup {
  id: string
  name: string
  description: string
  member_count: number
  created_at: string
  updated_at: string
}

export interface AdminGroupMember {
  id: string
  email: string
  role: string
  role_name: string
  status: string
}

export interface AdminGroupDetail {
  group: AdminGroup
  members: AdminGroupMember[]
}

export interface AdminSummary {
  id: string
  email: string
  role: string
  role_name?: string
  status: string
  groups?: AdminGroupRef[]
}

export const getRoles = () => apiJson<RoleCatalog>('/api/admin-roles')

export const createRole = (body: {
  name: string
  description?: string
  permissions: string[]
  code?: string
}) => apiJson<AdminRole>('/api/admin-roles', { method: 'POST', body })

export const updateRole = (
  slug: string,
  body: { name?: string; description?: string; permissions?: string[]; code?: string },
) =>
  apiJson<AdminRole>(`/api/admin-roles/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    body,
  })

export const deleteRole = (slug: string, code?: string) =>
  apiJson(`/api/admin-roles/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    body: { code },
  })

export const getGroups = () => apiJson<AdminGroup[]>('/api/admin-groups')

export const getGroup = (id: string) =>
  apiJson<AdminGroupDetail>(`/api/admin-groups/${encodeURIComponent(id)}`)

export const createGroup = (body: { name: string; description?: string }) =>
  apiJson<AdminGroup>('/api/admin-groups', { method: 'POST', body })

export const updateGroup = (id: string, body: { name: string; description?: string }) =>
  apiJson<AdminGroup>(`/api/admin-groups/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  })

export const deleteGroup = (id: string) =>
  apiJson(`/api/admin-groups/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const setGroupMembers = (id: string, adminIds: string[]) =>
  apiJson<AdminGroup>(`/api/admin-groups/${encodeURIComponent(id)}/members`, {
    method: 'PATCH',
    body: { admin_ids: adminIds },
  })

export const assignGroupRole = (id: string, role: string, code?: string) =>
  apiJson<{ status: string; updated: number }>(
    `/api/admin-groups/${encodeURIComponent(id)}/assign-role`,
    { method: 'POST', body: { role, code } },
  )

export const getAdmins = () => apiJson<AdminSummary[]>('/api/admins')

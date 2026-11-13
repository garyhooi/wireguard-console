import { useQuery } from '@tanstack/react-query'
import { apiJson } from './api'

export interface AdminGroupRef {
  id: string
  name: string
}

export interface Me {
  id: string
  email: string
  role: string
  role_name?: string
  is_super_admin?: boolean
  permissions?: string[]
  groups?: AdminGroupRef[]
  passkey_available?: boolean
  passkey_count?: number
  mfa_enabled?: boolean
  mfa_methods?: string[]
  totp_enabled?: boolean
  status?: string
}

export function can(me: Me | null | undefined, permission: string): boolean {
  // Unknown session (still loading or an older /admins/me payload) is treated
  // as "allow", not "deny": the API remains the authority, and this avoids
  // flashing a read-only shell during boot. A real custom role always carries
  // a permissions array and is filtered precisely.
  if (!me || !Array.isArray(me.permissions)) return true
  return me.permissions.includes('*') || me.permissions.includes(permission)
}

export function useMe() {
  return useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => apiJson<Me>('/api/admins/me'),
    staleTime: 30_000,
  })
}

export function useCan(permission: string): boolean {
  const { data: me } = useMe()
  return can(me, permission)
}
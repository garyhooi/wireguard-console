import { describe, expect, it } from 'vitest'
import { can, type Me } from '../permissions'

const baseMe: Me = { id: 'a', email: 'a@example.com', role: 'admin' }

describe('can', () => {
  it('honours the explicit permission array', () => {
    const me = { ...baseMe, permissions: ['network.view'] }
    expect(can(me, 'network.view')).toBe(true)
    expect(can(me, 'network.manage')).toBe(false)
  })

  it('treats the super-admin wildcard as everything', () => {
    expect(can({ ...baseMe, role: 'super_admin', permissions: ['*'] }, 'admins.manage')).toBe(true)
  })

  it('allows the unknown/legacy payload and lets the API decide', () => {
    expect(can(baseMe, 'system.manage')).toBe(true)
    expect(can(null, 'admins.view')).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { userLabel } from '../userLabel'

describe('userLabel', () => {
  it('formats name <email> (department)', () => {
    expect(userLabel('Alice Tan', 'alice@example.com', 'Engineering')).toBe(
      'Alice Tan <alice@example.com> (Engineering)',
    )
  })

  it('formats name <email> when the department is missing', () => {
    expect(userLabel('Alice Tan', 'alice@example.com')).toBe('Alice Tan <alice@example.com>')
    expect(userLabel('Alice Tan', 'alice@example.com', '')).toBe('Alice Tan <alice@example.com>')
  })

  it('formats email-only users with and without a department', () => {
    expect(userLabel('', 'bob@example.com')).toBe('bob@example.com')
    expect(userLabel(null, 'bob@example.com', 'Sales')).toBe('bob@example.com (Sales)')
  })

  it('formats name-only users with and without a department', () => {
    expect(userLabel('Carol', '')).toBe('Carol')
    expect(userLabel('Carol', undefined, 'Ops')).toBe('Carol (Ops)')
  })

  it('returns an em dash when nothing identifies the user', () => {
    expect(userLabel()).toBe('—')
    expect(userLabel('', '', '')).toBe('—')
    expect(userLabel(null, null, null)).toBe('—')
  })

  it('trims whitespace before formatting', () => {
    expect(userLabel('  Alice  ', ' alice@example.com ', ' Engineering ')).toBe(
      'Alice <alice@example.com> (Engineering)',
    )
  })
})

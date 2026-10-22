import { describe, expect, it } from 'vitest'
import { configFileName } from '../filename'

describe('configFileName', () => {
  it('slugifies the documented examples', () => {
    expect(configFileName('AI Agent')).toBe('ai-agent.conf')
    expect(configFileName('  AI   Agent  ')).toBe('ai-agent.conf')
    expect(configFileName("John's Device")).toBe('john-s-device.conf')
    expect(configFileName('VPN (Work)')).toBe('vpn-work.conf')
    expect(configFileName('my_tunnel')).toBe('my-tunnel.conf')
    expect(configFileName('../../etc/passwd')).toBe('etc-passwd.conf')
    expect(configFileName('我的设备')).toBe('wireguard.conf')
    expect(configFileName('')).toBe('wireguard.conf')
  })

  it('collapses every run of unusable characters to a single dash', () => {
    expect(configFileName('  AI   Agent  ')).toBe('ai-agent.conf')
    expect(configFileName('a---b___c...d')).toBe('a-b-c-d.conf')
    expect(configFileName('  \t\n Foo   Bar \n\t ')).toBe('foo-bar.conf')
  })

  it('leaves already-safe names unchanged', () => {
    expect(configFileName('already-safe')).toBe('already-safe.conf')
    expect(configFileName('tunnel42')).toBe('tunnel42.conf')
  })

  it('trims the slug itself', () => {
    expect(configFileName('...!!!hello!!!...')).toBe('hello.conf')
    expect(configFileName('---')).toBe('wireguard.conf')
  })

  it('falls back to "wireguard" for empty or missing names', () => {
    expect(configFileName()).toBe('wireguard.conf')
    expect(configFileName(undefined)).toBe('wireguard.conf')
    expect(configFileName(null)).toBe('wireguard.conf')
    expect(configFileName('')).toBe('wireguard.conf')
    expect(configFileName('   ')).toBe('wireguard.conf')
    expect(configFileName('\t\n  \r')).toBe('wireguard.conf')
  })

  it('falls back to "wireguard" when no ASCII alphanumerics remain', () => {
    expect(configFileName('我的设备')).toBe('wireguard.conf')
    expect(configFileName('🚀🚀🚀')).toBe('wireguard.conf')
    expect(configFileName('é')).toBe('wireguard.conf')
  })

  it('lowercases ASCII only, matching the backend helper exactly', () => {
    // Unicode full case mapping would lowercase 'İ' to 'i' + combining dot and
    // produce "i-x.conf"; both helpers deliberately fold only A-Z.
    expect(configFileName('İx')).toBe('x.conf')
    expect(configFileName('MIXED Case')).toBe('mixed-case.conf')
  })

  it('caps the base at 64 characters', () => {
    expect(configFileName('a'.repeat(80))).toBe(`${'a'.repeat(64)}.conf`)
    expect(configFileName(`${'a'.repeat(63)} b`)).toBe(`${'a'.repeat(63)}.conf`)
    // Case folding happens before the cap, so 64 uppercase A's become 64 a's.
    expect(configFileName('A'.repeat(64))).toBe(`${'a'.repeat(64)}.conf`)
  })

  it('always produces a safe filename', () => {
    const inputs = [
      'AI Agent',
      '  AI   Agent  ',
      "John's Device",
      'VPN (Work)',
      'my_tunnel',
      '../../etc/passwd',
      '我的设备',
      '',
      '   ',
      'already-safe',
      'tunnel42',
      'a---b___c...d',
      'a b/c\\d',
      'Ünïcode Name',
      '...!!!hello!!!...',
      '🚀 launch',
      'a'.repeat(80),
      'a'.repeat(63) + ' b',
      'CRLF\r\nName',
    ]

    for (const input of inputs) {
      const result = configFileName(input)
      expect(result).toMatch(/^[a-z0-9-]+\.conf$/)
      expect(result).not.toMatch(/\s|_|'|"|\//)
      expect(result.endsWith('.conf')).toBe(true)
      expect(result.slice(0, -'.conf'.length).length).toBeLessThanOrEqual(64)
    }
  })
})

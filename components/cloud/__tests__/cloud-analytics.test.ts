import { describe, expect, it } from 'vitest'
import { anonymizeAppUrl } from '../cloud-analytics'
import { STATIC_SECURITY_HEADERS } from '@/lib/security-headers'

describe('app.kledg.com analytics', () => {
  it('replaces the company slug, record ids and the query string', () => {
    expect(anonymizeAppUrl('https://app.kledg.com/boulangerie-martin/entries/cmutyyuef00lvczzlmw4on5qj?tab=lines')).toBe(
      'https://app.kledg.com/[societe]/entries/[id]',
    )
    expect(anonymizeAppUrl('https://app.kledg.com/sci-les-tilleuls')).toBe('https://app.kledg.com/[societe]')
    expect(anonymizeAppUrl('https://app.kledg.com/holding-dupont/management-fees/new')).toBe('https://app.kledg.com/[societe]/management-fees/new')
  })

  it('keeps application pages, without their tokens', () => {
    expect(anonymizeAppUrl('https://app.kledg.com/')).toBe('https://app.kledg.com/')
    expect(anonymizeAppUrl('https://app.kledg.com/settings/billing?session_id=cs_test_123')).toBe('https://app.kledg.com/settings/billing')
    expect(anonymizeAppUrl('https://app.kledg.com/reset-password?token=secret')).toBe('https://app.kledg.com/reset-password')
    expect(anonymizeAppUrl('https://app.kledg.com/setup?token=secret')).toBe('https://app.kledg.com/setup')
    expect(anonymizeAppUrl('https://app.kledg.com/inscription/confirmee')).toBe('https://app.kledg.com/inscription/confirmee')
  })

  it('[KLEDG-R3-CLOUD-03] leaves only the origin in referrers, so the script never reports a company page', () => {
    const all = STATIC_SECURITY_HEADERS.find((rule) => rule.source === '/:path*')
    expect(all?.headers.find((h) => h.key === 'Referrer-Policy')?.value).toBe('strict-origin')
  })
})

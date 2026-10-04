import { describe, expect, it } from 'vitest'
import { anonymizeAppUrl } from '../cloud-analytics'

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
})

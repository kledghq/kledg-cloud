/**
 * Plans (lib/cloud/billing/plans.ts) and their Stripe prices resolved by
 * lookup key (stripe-prices.ts): no price id in the code or the
 * environment, one cached list call, only active recurring EUR prices.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ALL_LOOKUP_KEYS, companyLimitLabel, extraCompaniesFor, isPlanId, lookupKey, PLAN_IDS, PLANS } from '../plans'
import { clearPriceCache, offeredPlanPrices, priceOf, resolvePrices } from '../stripe-prices'
import { cloudSettings, isCloudMode } from '../../config'
import { form, priceObject, pricesList, stripeFetch } from '../../__tests__/helpers/stripe-fixtures'

beforeEach(() => clearPriceCache())

describe('plans', () => {
  it('match the offer: Essentiel 1 company, Holding 5, Cabinet 25 included then billed per company', () => {
    expect(PLAN_IDS.map((id) => [PLANS[id].companyLimit, PLANS[id].includedCompanies])).toEqual([
      [1, null],
      [5, null],
      [null, 25],
    ])
    expect(extraCompaniesFor('cabinet', 24)).toBe(0)
    expect(extraCompaniesFor('cabinet', 31)).toBe(6)
    expect(extraCompaniesFor('holding', 31)).toBe(0)
    expect(companyLimitLabel(1)).toBe('1 société')
    expect(companyLimitLabel(5)).toBe('5 sociétés')
    expect(companyLimitLabel(null, 25)).toBe("25 sociétés incluses, puis à l'unité")
    expect(isPlanId('holding')).toBe(true)
    expect(isPlanId('dedicated_database')).toBe(false)
  })

  it('name the Stripe lookup keys of the offer, ten of them (one list call)', () => {
    expect(lookupKey('holding', 'year')).toBe('kledg_holding_yearly')
    expect(lookupKey('cabinet_extra_company', 'month')).toBe('kledg_cabinet_extra_company_monthly')
    expect(ALL_LOOKUP_KEYS).toHaveLength(10)
    expect(ALL_LOOKUP_KEYS).toContain('kledg_dedicated_database_yearly')
  })

  it('never hold a price id in the source', () => {
    for (const file of ['../plans.ts', '../stripe-prices.ts', '../checkout.service.ts']) {
      expect(readFileSync(path.join(__dirname, file), 'utf8')).not.toMatch(/price_[A-Za-z0-9]{8,}/)
    }
  })

  it('French descriptions without dashes and with a non-breaking space before colons', () => {
    for (const id of PLAN_IDS) {
      expect(PLANS[id].description).not.toMatch(/[–—]/)
      expect(PLANS[id].description).not.toMatch(/[^ ]:/)
    }
  })
})

describe('Stripe prices by lookup key', () => {
  it('are listed once with every lookup key, then served from the cache', async () => {
    const api = stripeFetch({ 'GET /v1/prices': pricesList() })
    const prices = await resolvePrices(api.stripe)
    expect(prices.get('kledg_holding_monthly')).toEqual({
      id: 'price_TestHoldingMonth',
      lookupKey: 'kledg_holding_monthly',
      unitAmount: 3900,
      currency: 'eur',
      interval: 'month',
    })
    expect((await priceOf(api.stripe, 'cabinet_extra_company', 'year'))?.unitAmount).toBe(3000)
    await resolvePrices(api.stripe)
    expect(api.calls).toHaveLength(1)
    const query = form(api.calls[0].body)
    expect(query).toMatchObject({ active: 'true', limit: '100' })
    expect(Object.entries(query).filter(([k]) => k.startsWith('lookup_keys')).map(([, v]) => v)).toEqual([...ALL_LOOKUP_KEYS])
    // The cache expires after ten minutes.
    await resolvePrices(api.stripe, Date.now() + 11 * 60_000)
    expect(api.calls).toHaveLength(2)
  })

  it('ignore what is not an active recurring EUR price, and offer only the plans that have one', async () => {
    const usd = { ...priceObject('essentiel', 'month', { expandProduct: false }), currency: 'usd' }
    const oneTime = { ...priceObject('essentiel', 'year', { expandProduct: false }), recurring: null }
    const list = { ...pricesList(['holding', 'cabinet', 'cabinet_extra_company']), data: [...pricesList(['holding', 'cabinet', 'cabinet_extra_company']).data, usd, oneTime] }
    const api = stripeFetch({ 'GET /v1/prices': list })
    expect(await offeredPlanPrices(api.stripe)).toEqual([
      { id: 'holding', prices: { month: 3900, year: 39000 }, extraCompany: {} },
      { id: 'cabinet', prices: { month: 9900, year: 99000 }, extraCompany: { month: 300, year: 3000 } },
    ])
  })
})

describe('cloud settings', () => {
  it('are off unless KLEDG_CLOUD_MODE=true', () => {
    expect(isCloudMode({})).toBe(false)
    expect(isCloudMode({ KLEDG_CLOUD_MODE: '1' })).toBe(false)
    expect(isCloudMode({ KLEDG_CLOUD_MODE: 'true' })).toBe(true)
  })

  it('default to the durations of the CGV, and never remind a renewal less than a month ahead', () => {
    expect(cloudSettings({})).toEqual({ trialDays: 30, graceDays: 14, retrievalDays: 30, deletionDays: 30, renewalNoticeDays: 35, unverifiedAccountDays: 7 })
    expect(cloudSettings({ KLEDG_CLOUD_RENEWAL_NOTICE_DAYS: '10' }).renewalNoticeDays).toBe(31)
    expect(cloudSettings({ KLEDG_CLOUD_TRIAL_DAYS: '-3', KLEDG_CLOUD_GRACE_DAYS: 'abc' })).toMatchObject({ trialDays: 30, graceDays: 14 })
  })
})

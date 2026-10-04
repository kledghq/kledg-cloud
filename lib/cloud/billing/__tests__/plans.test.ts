/**
 * Plans (lib/cloud/billing/plans.ts): prices only from the environment,
 * never from the code, and only well-formed Stripe price ids.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { companyLimitLabel, isPlanId, offeredPlans, planOfPrice, PLAN_IDS, PLANS, priceIdFor } from '../plans'
import { cloudSettings, isCloudMode } from '../../config'

const env = {
  STRIPE_PRICE_ESSENTIEL_MONTHLY: 'price_TestEssentielMonth01',
  STRIPE_PRICE_HOLDING_MONTHLY: 'price_TestHoldingMonth0001',
  STRIPE_PRICE_HOLDING_YEARLY: 'price_TestHoldingYear00001',
  STRIPE_PRICE_CABINET_MONTHLY: 'not-a-price-id',
}

describe('plans', () => {
  it('read their Stripe prices from the environment only', () => {
    expect(priceIdFor('holding', 'year', env)).toBe('price_TestHoldingYear00001')
    expect(priceIdFor('essentiel', 'year', env)).toBeNull()
    // A malformed value is never sent to Stripe.
    expect(priceIdFor('cabinet', 'month', env)).toBeNull()
    expect(priceIdFor('holding', 'month', {})).toBeNull()
  })

  it('find the plan of a price, of any interval, and nothing for a foreign price', () => {
    expect(planOfPrice('price_TestHoldingMonth0001', env)).toBe('holding')
    expect(planOfPrice('price_TestHoldingYear00001', env)).toBe('holding')
    expect(planOfPrice('price_SomebodyElse000001', env)).toBeNull()
    expect(planOfPrice(null, env)).toBeNull()
  })

  it('offer only the plans with a configured price', () => {
    expect(offeredPlans(env).map((p) => [p.id, p.intervals])).toEqual([
      ['essentiel', ['month']],
      ['holding', ['month', 'year']],
    ])
    expect(offeredPlans({})).toEqual([])
  })

  it('have French names and descriptions, growing limits and no price in the source', () => {
    expect(PLAN_IDS.map((id) => PLANS[id].companyLimit)).toEqual([1, 5, 100])
    for (const id of PLAN_IDS) {
      expect(PLANS[id].description).not.toMatch(/[–—]/)
      expect(PLANS[id].description).not.toMatch(/[^ ]:/)
    }
    const source = readFileSync(path.join(__dirname, '../plans.ts'), 'utf8')
    expect(source).not.toMatch(/price_[A-Za-z0-9]{8,}/)
    expect(isPlanId('holding')).toBe(true)
    expect(isPlanId('gold')).toBe(false)
  })

  it('label limits in French', () => {
    expect(companyLimitLabel(1)).toBe('1 société')
    expect(companyLimitLabel(5)).toBe('5 sociétés')
    expect(companyLimitLabel(null)).toBe('un nombre illimité de sociétés')
  })
})

describe('cloud settings', () => {
  it('are off unless KLEDG_CLOUD_MODE=true', () => {
    expect(isCloudMode({})).toBe(false)
    expect(isCloudMode({ KLEDG_CLOUD_MODE: '1' })).toBe(false)
    expect(isCloudMode({ KLEDG_CLOUD_MODE: 'true' })).toBe(true)
  })

  it('default to a 30 day trial, 14 days of grace, 30 days before a deletion', () => {
    expect(cloudSettings({})).toEqual({ trialDays: 30, graceDays: 14, deletionDays: 30, trialCompanyLimit: 3, unverifiedAccountDays: 7 })
    expect(cloudSettings({ KLEDG_CLOUD_TRIAL_DAYS: '14', KLEDG_CLOUD_GRACE_DAYS: '7' })).toMatchObject({ trialDays: 14, graceDays: 7 })
    // Invalid values fall back to the defaults.
    expect(cloudSettings({ KLEDG_CLOUD_TRIAL_DAYS: '-3', KLEDG_CLOUD_GRACE_DAYS: 'abc', KLEDG_CLOUD_DELETION_DAYS: '0' })).toMatchObject({
      trialDays: 30,
      graceDays: 14,
      deletionDays: 30,
    })
  })
})

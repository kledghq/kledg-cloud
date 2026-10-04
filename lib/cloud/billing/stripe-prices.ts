/**
 * Stripe prices of Kledg Cloud, resolved by lookup key (plans.ts) with one
 * `prices.list` call, cached for a few minutes per server instance. Only
 * active EUR prices count; a price that is missing or malformed is simply
 * not offered (and logged), never guessed.
 */

import type Stripe from 'stripe'
import { logger } from '@/lib/logger'
import { ALL_LOOKUP_KEYS, BILLING_INTERVALS, lookupKey, PLAN_IDS, type BillingInterval, type PlanId, type ProductKind } from './plans'

export interface ResolvedPrice {
  id: string
  lookupKey: string
  /** Amount in cents, excluding tax (tax_behavior exclusive). */
  unitAmount: number
  currency: 'eur'
  interval: BillingInterval
}

const CACHE_MS = 10 * 60 * 1000
let cache: { at: number; prices: Map<string, ResolvedPrice> } | null = null

/** Forgets the cached prices (tests, or right after the operator changed them). */
export function clearPriceCache(): void {
  cache = null
}

export async function resolvePrices(stripe: Stripe, now: number = Date.now()): Promise<Map<string, ResolvedPrice>> {
  if (cache && now - cache.at < CACHE_MS) return cache.prices
  const list = await stripe.prices.list({ lookup_keys: [...ALL_LOOKUP_KEYS], active: true, limit: 100 })
  const prices = new Map<string, ResolvedPrice>()
  for (const price of list.data) {
    const recurring: string | undefined = price.recurring?.interval
    const interval = BILLING_INTERVALS.find((i) => i === recurring) ?? null
    if (!price.lookup_key || price.currency !== 'eur' || price.unit_amount === null || !interval) {
      logger.warn('Stripe price ignored: not an active recurring EUR price', { priceId: price.id })
      continue
    }
    prices.set(price.lookup_key, { id: price.id, lookupKey: price.lookup_key, unitAmount: price.unit_amount, currency: 'eur', interval })
  }
  cache = { at: now, prices }
  return prices
}

export async function priceOf(stripe: Stripe, kind: ProductKind, interval: BillingInterval): Promise<ResolvedPrice | null> {
  return (await resolvePrices(stripe)).get(lookupKey(kind, interval)) ?? null
}

export interface OfferedPlanPrices {
  id: PlanId
  prices: Partial<Record<BillingInterval, number>>
  /** Cabinet: price of each extra company, by interval. */
  extraCompany: Partial<Record<BillingInterval, number>>
}

/** The plans that have a price, with their amounts (cents, excluding tax). */
export async function offeredPlanPrices(stripe: Stripe): Promise<OfferedPlanPrices[]> {
  const prices = await resolvePrices(stripe)
  const amounts = (kind: ProductKind) =>
    Object.fromEntries(BILLING_INTERVALS.flatMap((i) => (prices.has(lookupKey(kind, i)) ? [[i, prices.get(lookupKey(kind, i))!.unitAmount]] : [])))
  return PLAN_IDS.map((id) => ({ id, prices: amounts(id), extraCompany: id === 'cabinet' ? amounts('cabinet_extra_company') : {} })).filter(
    (plan) => Object.keys(plan.prices).length > 0,
  )
}

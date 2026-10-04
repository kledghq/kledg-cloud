/**
 * What the "Facturation" page shows (app/(account)/settings/billing): the
 * account's state, its plan and usage, the plans and their Stripe prices,
 * whether the free trial is still available. Plain data with ISO strings,
 * handed to client components.
 */

import type Stripe from 'stripe'
import type { CurrentUser } from '@/lib/session'
import { logger } from '@/lib/logger'
import { accessOf, countedCompanies, findBillingAccount, virtualBillingAccount } from './billing-account.service'
import { PLANS, type BillingInterval, type PlanId } from './plans'
import { hasLiveSubscription, type BillingPhase, type BillingReason } from './state'
import { offeredPlanPrices } from './stripe-prices'
import { getStripe, isStripeConfigured } from './stripe'
import { cloudSettings } from '../config'

export interface BillingOverview {
  phase: BillingPhase
  reason: BillingReason | null
  writable: boolean
  planId: PlanId | null
  planName: string | null
  billingInterval: BillingInterval | null
  companyCount: number
  companyLimit: number | null
  extraCompanies: number
  trialEndsAt: string | null
  readOnlyAt: string | null
  retrievalEndsAt: string | null
  deletionAt: string | null
  endsAt: string | null
  /** The free trial is still available (one per client). */
  trialAvailable: boolean
  trialDays: number
  /** A subscription Stripe still bills (a second checkout is refused; the portal manages it). */
  subscribed: boolean
  /** A Stripe customer exists: the portal and the invoices are available. */
  hasCustomer: boolean
  stripeConfigured: boolean
  plans: Array<{
    id: PlanId
    name: string
    description: string
    companyLimit: number | null
    includedCompanies: number | null
    /** Cents excluding tax, by interval. */
    prices: Partial<Record<BillingInterval, number>>
    extraCompany: Partial<Record<BillingInterval, number>>
  }>
}

const iso = (date: Date | null) => (date ? date.toISOString() : null)

export async function loadBillingOverview(user: CurrentUser, now: Date = new Date(), stripe?: () => Stripe): Promise<BillingOverview> {
  const stored = await findBillingAccount(user.id)
  const account = stored ?? virtualBillingAccount(user.id, now)
  const access = accessOf(account, now)
  const stripeConfigured = isStripeConfigured()
  let plans: BillingOverview['plans'] = []
  if (stripeConfigured) {
    try {
      plans = (await offeredPlanPrices((stripe ?? getStripe)())).map(({ id, prices, extraCompany }) => ({
        id,
        name: PLANS[id].name,
        description: PLANS[id].description,
        companyLimit: PLANS[id].companyLimit,
        includedCompanies: PLANS[id].includedCompanies,
        prices,
        extraCompany,
      }))
    } catch (error) {
      logger.error('Stripe prices could not be read for the billing page', { error })
    }
  }
  return {
    phase: access.phase,
    reason: access.reason,
    writable: access.writable,
    planId: access.planId,
    planName: access.planId ? PLANS[access.planId].name : null,
    billingInterval: account.billingInterval === 'month' || account.billingInterval === 'year' ? account.billingInterval : null,
    companyCount: stored ? await countedCompanies(stored.id) : 0,
    companyLimit: access.companyLimit,
    extraCompanies: account.extraCompanies,
    trialEndsAt: iso(access.trialEndsAt),
    readOnlyAt: iso(access.readOnlyAt),
    retrievalEndsAt: iso(access.retrievalEndsAt),
    deletionAt: iso(access.deletionAt),
    endsAt: iso(access.endsAt),
    trialAvailable: !account.trialUsed && !account.stripeSubscriptionId,
    trialDays: cloudSettings().trialDays,
    subscribed: hasLiveSubscription(account.subscriptionStatus),
    hasCustomer: Boolean(account.stripeCustomerId),
    stripeConfigured,
    plans,
  }
}

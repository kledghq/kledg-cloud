/**
 * What the "Facturation" page shows (app/(account)/settings/billing): the
 * account's state, its plan and usage, the plans offered, whether Stripe is
 * set up. Plain data with ISO strings, handed to client components.
 */

import type { CurrentUser } from '@/lib/session'
import { accessOf, countedCompanies, findBillingAccount, virtualBillingAccount } from './billing-account.service'
import { offeredPlans, PLANS, type BillingInterval, type PlanId } from './plans'
import { hasLiveSubscription, type BillingPhase, type BillingReason } from './state'
import { isStripeConfigured } from './stripe'

export interface BillingOverview {
  phase: BillingPhase
  reason: BillingReason | null
  writable: boolean
  planId: PlanId | null
  planName: string | null
  companyCount: number
  companyLimit: number | null
  trialEndsAt: string | null
  readOnlyAt: string | null
  endsAt: string | null
  /** A subscription Stripe still bills (a second checkout is refused; the portal manages it). */
  subscribed: boolean
  /** A Stripe customer exists: the portal and the invoices are available. */
  hasCustomer: boolean
  stripeConfigured: boolean
  deletionScheduledFor: string | null
  plans: Array<{ id: PlanId; name: string; description: string; companyLimit: number | null; intervals: BillingInterval[] }>
}

const iso = (date: Date | null) => (date ? date.toISOString() : null)

export async function loadBillingOverview(user: CurrentUser, now: Date = new Date()): Promise<BillingOverview> {
  const stored = await findBillingAccount(user.id)
  const account = stored ?? virtualBillingAccount(user.id, now)
  const access = accessOf(account, now)
  return {
    phase: access.phase,
    reason: access.reason,
    writable: access.writable,
    planId: access.planId,
    planName: access.planId ? PLANS[access.planId].name : null,
    companyCount: stored ? await countedCompanies(stored.id) : 0,
    companyLimit: access.companyLimit,
    trialEndsAt: iso(access.trialEndsAt),
    readOnlyAt: iso(access.readOnlyAt),
    endsAt: iso(access.endsAt),
    subscribed: hasLiveSubscription(account.subscriptionStatus),
    hasCustomer: Boolean(account.stripeCustomerId),
    stripeConfigured: isStripeConfigured(),
    deletionScheduledFor: iso(account.deletionScheduledFor),
    plans: offeredPlans().map(({ id, name, description, companyLimit, intervals }) => ({ id, name, description, companyLimit, intervals })),
  }
}

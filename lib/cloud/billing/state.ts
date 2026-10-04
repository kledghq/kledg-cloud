/**
 * Billing state machine of a Kledg Cloud account. Pure: the state follows
 * from the stored snapshot (our trial, the Stripe subscription mirrored by
 * the webhook) and the time, so it never needs a cron to move on.
 *
 *   no subscription: trial (until trialEndsAt), then grace, then read-only
 *   active / trialing (Stripe): active (cancelAt set while it is ending)
 *   past_due / unpaid: grace from the first failed payment, then read-only
 *   canceled / incomplete_expired: our trial if it still runs, else grace
 *     from the end of the subscription, then read-only
 *   incomplete (first payment not done): as if there were no subscription
 *   paused: read-only
 *
 * Read-only never hides or deletes anything: reading, the FEC and the full
 * data export stay available (legal retention, data portability). Only
 * writes and new companies are refused (lib/cloud/enforcement.ts).
 */

import { PLANS, type PlanId } from './plans'

export type BillingPhase = 'trial' | 'active' | 'grace' | 'read_only'

/** Why an account is in grace or read-only. */
export type BillingReason = 'trial_ended' | 'payment_failed' | 'subscription_ended' | 'paused'

/** What the state needs from a billing account row. */
export interface BillingSnapshot {
  trialEndsAt: Date
  subscriptionStatus: string | null
  planId: string | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  subscriptionEndedAt: Date | null
  paymentFailedAt: Date | null
}

export interface BillingAccess {
  phase: BillingPhase
  /** Whether the account's companies accept writes and it may create companies. */
  writable: boolean
  reason: BillingReason | null
  /** The paid plan in force, null during the trial or without a subscription. */
  planId: PlanId | null
  /** Companies the account may own now (null: no limit). */
  companyLimit: number | null
  /** End of the trial (phase trial). */
  trialEndsAt: Date | null
  /** When the account turns read-only (phase grace), or turned (read_only, when known). */
  readOnlyAt: Date | null
  /** End of the paid subscription when it will not renew (active, cancellation requested). */
  endsAt: Date | null
}

const DAY_MS = 24 * 60 * 60 * 1000

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS)
}

/** Whole days from `now` to `until`, rounded up (0 once it passed). */
export function daysLeft(until: Date, now: Date): number {
  return Math.max(0, Math.ceil((until.getTime() - now.getTime()) / DAY_MS))
}

const PAID_STATUSES = new Set(['active', 'trialing'])
const PAYMENT_ISSUE_STATUSES = new Set(['past_due', 'unpaid'])
const ENDED_STATUSES = new Set(['canceled', 'incomplete_expired'])

/** Subscription statuses that mean the account already pays (a second checkout is refused). */
export function hasLiveSubscription(status: string | null): boolean {
  return status !== null && (PAID_STATUSES.has(status) || PAYMENT_ISSUE_STATUSES.has(status) || status === 'paused')
}

function planOf(snapshot: BillingSnapshot): PlanId | null {
  return snapshot.planId && snapshot.planId in PLANS ? (snapshot.planId as PlanId) : null
}

export function billingAccess(
  snapshot: BillingSnapshot,
  now: Date,
  settings: { graceDays: number; trialCompanyLimit: number },
): BillingAccess {
  const plan = planOf(snapshot)
  const paidLimit = plan ? PLANS[plan].companyLimit : settings.trialCompanyLimit
  const base = { trialEndsAt: null, readOnlyAt: null, endsAt: null }
  const status = snapshot.subscriptionStatus

  /** Writable until `start + grace`, read-only after. */
  const graceFrom = (start: Date, reason: BillingReason, companyLimit: number | null): BillingAccess => {
    const readOnlyAt = addDays(start, settings.graceDays)
    return now < readOnlyAt
      ? { ...base, phase: 'grace', writable: true, reason, planId: plan, companyLimit, readOnlyAt }
      : { ...base, phase: 'read_only', writable: false, reason, planId: plan, companyLimit: 0, readOnlyAt }
  }

  /** Our own trial, then its grace. */
  const trial = (): BillingAccess =>
    now < snapshot.trialEndsAt
      ? { ...base, phase: 'trial', writable: true, reason: null, planId: null, companyLimit: settings.trialCompanyLimit, trialEndsAt: snapshot.trialEndsAt }
      : graceFrom(snapshot.trialEndsAt, 'trial_ended', settings.trialCompanyLimit)

  if (status && PAID_STATUSES.has(status)) {
    const ending = snapshot.cancelAtPeriodEnd ? snapshot.currentPeriodEnd : null
    return { ...base, phase: 'active', writable: true, reason: null, planId: plan, companyLimit: paidLimit, endsAt: ending }
  }
  if (status && PAYMENT_ISSUE_STATUSES.has(status)) {
    return graceFrom(snapshot.paymentFailedAt ?? snapshot.currentPeriodEnd ?? now, 'payment_failed', paidLimit)
  }
  if (status && ENDED_STATUSES.has(status)) {
    if (now < snapshot.trialEndsAt) return trial()
    const ended = snapshot.subscriptionEndedAt ?? snapshot.currentPeriodEnd ?? now
    // Never before the end of our own trial: a subscription canceled during it keeps the trial's grace.
    return graceFrom(ended > snapshot.trialEndsAt ? ended : snapshot.trialEndsAt, 'subscription_ended', paidLimit)
  }
  if (status === 'paused') {
    return { ...base, phase: 'read_only', writable: false, reason: 'paused', planId: plan, companyLimit: 0 }
  }
  // No subscription, or a first payment not completed (incomplete).
  return trial()
}

/**
 * Billing state machine of a Kledg Cloud account. Pure: the state follows
 * from the stored snapshot (the Stripe subscription mirrored by the
 * webhook, a deletion request) and the time, so it never waits for a job.
 * It implements the commitments of the CGV (version 1.0):
 *
 *   no subscription (or a first payment not done): none, nothing to write
 *     yet; the trial starts by choosing a plan at Checkout
 *   trialing: trial, writable (30 days, no card; without one added it ends)
 *   active: active (endsAt set once cancelled at period end)
 *   past_due / unpaid: grace for 14 days after the failed payment, then
 *     read-only until paid (CGV art. 9)
 *   canceled / incomplete_expired (contract ended, trial ended without a
 *     card included): read-only retrieval for 30 days, then deletion
 *     (CGV art. 14)
 *   paused: read-only
 *   deletion requested: read-only for 30 days, cancellable, then deletion
 *     (CGV art. 15)
 *
 * Read-only never hides anything: reading, the FEC and the full data export
 * stay available. Only writes and new companies are refused
 * (lib/cloud/enforcement.ts).
 */

import { PLANS, type PlanId } from './plans'

export type BillingPhase = 'none' | 'trial' | 'active' | 'grace' | 'read_only'

/** Why an account is in grace, read-only, or has nothing yet. */
export type BillingReason = 'no_subscription' | 'payment_failed' | 'contract_ended' | 'paused' | 'deletion_requested'

/** What the state needs from a billing account row. */
export interface BillingSnapshot {
  subscriptionStatus: string | null
  planId: string | null
  trialEnd: Date | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  subscriptionEndedAt: Date | null
  paymentFailedAt: Date | null
  deletionScheduledFor: Date | null
  /** "requested" by the owner, or "contract_ended" (end of the retrieval period). */
  deletionReason: string | null
}

export interface BillingAccess {
  phase: BillingPhase
  /** Whether the account's companies accept writes and it may create companies. */
  writable: boolean
  reason: BillingReason | null
  /** The plan of the subscription (trial included), null without one. */
  planId: PlanId | null
  /** Companies the account may own (null: no hard limit; 0 when it may create none). */
  companyLimit: number | null
  /** End of the trial (phase trial). */
  trialEndsAt: Date | null
  /** When the account turns read-only (grace) or turned (read-only after a failed payment). */
  readOnlyAt: Date | null
  /** End of the read-only retrieval period, when the data is deleted (contract ended). */
  retrievalEndsAt: Date | null
  /** Date of a scheduled deletion (requested by the owner, or after the retrieval period). */
  deletionAt: Date | null
  /** End of a paid subscription that will not renew (active, cancellation requested). */
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

const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused'])
const PAYMENT_ISSUE_STATUSES = new Set(['past_due', 'unpaid'])
const ENDED_STATUSES = new Set(['canceled', 'incomplete_expired'])

/** Subscription statuses Stripe still bills or may bill (a second checkout is refused). */
export function hasLiveSubscription(status: string | null): boolean {
  return status !== null && LIVE_STATUSES.has(status)
}

/** Statuses of a contract that ended. */
export function hasEndedSubscription(status: string | null): boolean {
  return status !== null && ENDED_STATUSES.has(status)
}

function planOf(snapshot: BillingSnapshot): PlanId | null {
  return snapshot.planId && Object.prototype.hasOwnProperty.call(PLANS, snapshot.planId) ? (snapshot.planId as PlanId) : null
}

export function billingAccess(snapshot: BillingSnapshot, now: Date, settings: { graceDays: number; retrievalDays: number }): BillingAccess {
  const plan = planOf(snapshot)
  const limit = plan ? PLANS[plan].companyLimit : 0
  const base: BillingAccess = {
    phase: 'none',
    writable: false,
    reason: null,
    planId: plan,
    companyLimit: limit,
    trialEndsAt: null,
    readOnlyAt: null,
    retrievalEndsAt: null,
    deletionAt: snapshot.deletionScheduledFor,
    endsAt: null,
  }
  const readOnly = (reason: BillingReason, extra: Partial<BillingAccess> = {}): BillingAccess => ({
    ...base,
    phase: 'read_only',
    writable: false,
    reason,
    companyLimit: 0,
    ...extra,
  })
  const status = snapshot.subscriptionStatus

  if (snapshot.deletionScheduledFor && snapshot.deletionReason === 'requested') return readOnly('deletion_requested')

  if (status === 'trialing') {
    return { ...base, phase: 'trial', writable: true, trialEndsAt: snapshot.trialEnd ?? snapshot.currentPeriodEnd }
  }
  if (status === 'active') {
    return { ...base, phase: 'active', writable: true, endsAt: snapshot.cancelAtPeriodEnd ? snapshot.currentPeriodEnd : null }
  }
  if (status && PAYMENT_ISSUE_STATUSES.has(status)) {
    const readOnlyAt = addDays(snapshot.paymentFailedAt ?? snapshot.currentPeriodEnd ?? now, settings.graceDays)
    return now < readOnlyAt
      ? { ...base, phase: 'grace', writable: true, reason: 'payment_failed', readOnlyAt }
      : readOnly('payment_failed', { readOnlyAt })
  }
  if (status && ENDED_STATUSES.has(status)) {
    const ended = snapshot.subscriptionEndedAt ?? snapshot.currentPeriodEnd ?? now
    // The scheduled deletion is the end of the retrieval period once the notice went out.
    return readOnly('contract_ended', { retrievalEndsAt: snapshot.deletionScheduledFor ?? addDays(ended, settings.retrievalDays) })
  }
  if (status === 'paused') return readOnly('paused')
  // No subscription yet, or a first payment not completed (incomplete).
  return { ...base, reason: 'no_subscription', companyLimit: 0 }
}

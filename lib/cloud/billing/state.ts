/**
 * Billing state machine of a Kledg Cloud account. Pure: the state follows
 * from the stored snapshot (the Stripe subscription mirrored by the
 * webhook, a deletion request) and the time, so it never waits for a job.
 * It implements the commitments of the CGV (version 1.0):
 *
 *   no subscription (or a first payment not done): none, nothing to write
 *     yet; the trial starts by choosing a plan at Checkout
 *   trialing: trial, writable (30 days, no card; without one added it ends;
 *     Cabinet limited to its 25 included companies until paid)
 *   active: active (endsAt set once cancelled at period end)
 *   past_due / unpaid: grace for 14 days after the failed payment, then
 *     read-only until paid (CGV art. 9)
 *   canceled / incomplete_expired (contract ended, trial ended without a
 *     card included): read-only retrieval for 30 days, then deletion
 *     (CGV art. 14)
 *   paused: read-only
 *   deletion requested: read-only for 30 days, cancellable, then deletion
 *     (CGV art. 15)
 *   trialing past its end, or active past the end of a period that does not
 *     renew, by more than 2 days: the webhook missed the change Stripe made
 *     then (KLEDG-CLOUD-005), read-only until the daily reconciliation
 *     (resyncStaleBillingAccounts) reads the subscription again
 *   active past the end of a period that renews, by more than 7 days, with
 *     no read from Stripe since that end: the renewal was never confirmed
 *     (neither webhook nor 7 daily reconciliations), read-only until a
 *     reconciliation or a payment brings the new period. A paying customer
 *     whose webhook is merely late is never blocked: the daily
 *     reconciliation reads Stripe again from the first hour past the end
 *
 * Read-only never hides anything: reading, the FEC and the full data export
 * stay available. Only writes and new companies are refused
 * (lib/cloud/enforcement.ts).
 */

import { PLANS, type PlanId } from './plans'

export type BillingPhase = 'none' | 'trial' | 'active' | 'grace' | 'read_only'

/** Why an account is in grace, read-only, or has nothing yet. */
export type BillingReason = 'no_subscription' | 'payment_failed' | 'contract_ended' | 'paused' | 'deletion_requested' | 'billing_outdated'

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
  /** Time of the last read of the subscription from Stripe (webhook or daily reconciliation); absent: never. */
  stripeSyncedAt?: Date | null
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

/**
 * How long past a trial end, or the end of a period that does not renew, a
 * snapshot still saying "trialing" or "active" is believed: Stripe changes
 * the subscription at that date and its webhook normally arrives within
 * minutes; the daily reconciliation catches up the rest (KLEDG-CLOUD-005).
 */
export const STALE_SNAPSHOT_MS = 2 * 24 * 60 * 60 * 1000

/**
 * How long past the end of a period that renews an "active" snapshot is
 * believed without any read from Stripe since that end (KLEDG-CLOUD-005,
 * residual): seven daily reconciliations, each of which would bring the new
 * period of a subscription Stripe renewed.
 */
export const RENEWAL_UNCONFIRMED_MS = 7 * 24 * 60 * 60 * 1000

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

  // A date Stripe acted on long ago without the webhook telling: the snapshot is out of date (KLEDG-CLOUD-005).
  const outdated = (end: Date | null) => end !== null && now.getTime() > end.getTime() + STALE_SNAPSHOT_MS

  if (status === 'trialing') {
    const trialEndsAt = snapshot.trialEnd ?? snapshot.currentPeriodEnd
    if (outdated(trialEndsAt)) return readOnly('billing_outdated', { trialEndsAt })
    // A trial is free and needs no card: Cabinet's companies beyond the 25 included are billed only once
    // it is paid, so the trial stops at the included ones (KLEDG-CLOUD-003).
    const trialLimit = plan ? (PLANS[plan].companyLimit ?? PLANS[plan].includedCompanies) : 0
    return { ...base, phase: 'trial', writable: true, companyLimit: trialLimit, trialEndsAt }
  }
  if (status === 'active') {
    const endsAt = snapshot.cancelAtPeriodEnd ? snapshot.currentPeriodEnd : null
    if (outdated(endsAt)) return readOnly('billing_outdated', { endsAt })
    // A renewal never confirmed: no read from Stripe since the period ended, 7 days on.
    const periodEnd = snapshot.currentPeriodEnd
    const confirmedSince = (at: Date) => (snapshot.stripeSyncedAt ?? null) !== null && snapshot.stripeSyncedAt!.getTime() > at.getTime()
    if (!endsAt && periodEnd && now.getTime() > periodEnd.getTime() + RENEWAL_UNCONFIRMED_MS && !confirmedSince(periodEnd)) {
      return readOnly('billing_outdated', { readOnlyAt: new Date(periodEnd.getTime() + RENEWAL_UNCONFIRMED_MS) })
    }
    return { ...base, phase: 'active', writable: true, endsAt }
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

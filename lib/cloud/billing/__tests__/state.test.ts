/**
 * Billing state machine (lib/cloud/billing/state.ts): every transition, from
 * the stored snapshot and the time alone, against the commitments of the
 * CGV (version 1.0): 14 days after a failed payment, 30 days of read-only
 * retrieval after the end of the contract, a deletion request read-only.
 */

import { describe, expect, it } from 'vitest'
import { addDays, billingAccess, daysLeft, hasEndedSubscription, hasLiveSubscription, type BillingSnapshot } from '../state'

const settings = { graceDays: 14, retrievalDays: 30 }
const now = new Date('2026-11-10T09:00:00Z')

const snapshot = (over: Partial<BillingSnapshot> = {}): BillingSnapshot => ({
  subscriptionStatus: null,
  planId: null,
  trialEnd: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  subscriptionEndedAt: null,
  paymentFailedAt: null,
  deletionScheduledFor: null,
  deletionReason: null,
  ...over,
})

describe('billing state', () => {
  it('has nothing to write without a subscription: the trial starts at Checkout', () => {
    for (const status of [null, 'incomplete']) {
      expect(billingAccess(snapshot({ subscriptionStatus: status }), now, settings)).toMatchObject({
        phase: 'none',
        writable: false,
        reason: 'no_subscription',
        companyLimit: 0,
      })
    }
  })

  it('is a writable trial with the limit of the plan tried', () => {
    const trialEnd = addDays(now, 12)
    expect(billingAccess(snapshot({ subscriptionStatus: 'trialing', planId: 'holding', trialEnd }), now, settings)).toMatchObject({
      phase: 'trial',
      writable: true,
      planId: 'holding',
      companyLimit: 5,
      trialEndsAt: trialEnd,
    })
    expect(daysLeft(trialEnd, now)).toBe(12)
  })

  it('is active with the limit of its plan; Cabinet has no hard limit', () => {
    expect(billingAccess(snapshot({ subscriptionStatus: 'active', planId: 'essentiel' }), now, settings)).toMatchObject({
      phase: 'active',
      writable: true,
      companyLimit: 1,
      endsAt: null,
    })
    expect(billingAccess(snapshot({ subscriptionStatus: 'active', planId: 'cabinet' }), now, settings).companyLimit).toBeNull()
  })

  it('tells when a cancelled subscription ends, and stays writable until then', () => {
    const end = new Date('2026-12-01T00:00:00Z')
    expect(
      billingAccess(snapshot({ subscriptionStatus: 'active', planId: 'holding', cancelAtPeriodEnd: true, currentPeriodEnd: end }), now, settings),
    ).toMatchObject({ phase: 'active', writable: true, endsAt: end })
  })

  it('stays writable 14 days after a failed payment, then turns read-only until paid (CGV art. 9)', () => {
    const failed = new Date('2026-11-01T08:00:00Z')
    for (const status of ['past_due', 'unpaid']) {
      const s = snapshot({ subscriptionStatus: status, planId: 'holding', paymentFailedAt: failed })
      expect(billingAccess(s, addDays(failed, 13.9), settings)).toMatchObject({
        phase: 'grace',
        writable: true,
        reason: 'payment_failed',
        readOnlyAt: addDays(failed, 14),
        companyLimit: 5,
      })
      expect(billingAccess(s, addDays(failed, 14), settings)).toMatchObject({ phase: 'read_only', writable: false, reason: 'payment_failed', companyLimit: 0 })
    }
    // An unknown failure date counts from the period end.
    const periodEnd = new Date('2026-10-20T00:00:00Z')
    expect(billingAccess(snapshot({ subscriptionStatus: 'past_due', currentPeriodEnd: periodEnd }), addDays(periodEnd, 15), settings).phase).toBe('read_only')
  })

  it('is read-only for 30 days of retrieval once the contract ended, trial without a card included (CGV art. 14)', () => {
    const ended = new Date('2026-11-05T00:00:00Z')
    for (const status of ['canceled', 'incomplete_expired']) {
      expect(billingAccess(snapshot({ subscriptionStatus: status, planId: 'holding', subscriptionEndedAt: ended }), now, settings)).toMatchObject({
        phase: 'read_only',
        writable: false,
        reason: 'contract_ended',
        retrievalEndsAt: addDays(ended, 30),
      })
    }
    // Once the notice went out, the scheduled deletion is the end of retrieval.
    const scheduled = addDays(now, 7)
    expect(
      billingAccess(
        snapshot({ subscriptionStatus: 'canceled', subscriptionEndedAt: ended, deletionScheduledFor: scheduled, deletionReason: 'contract_ended' }),
        now,
        settings,
      ).retrievalEndsAt,
    ).toEqual(scheduled)
  })

  it('is read-only while a requested deletion waits, whatever the subscription (CGV art. 15)', () => {
    const at = addDays(now, 30)
    expect(
      billingAccess(snapshot({ subscriptionStatus: 'active', planId: 'holding', deletionScheduledFor: at, deletionReason: 'requested' }), now, settings),
    ).toMatchObject({ phase: 'read_only', writable: false, reason: 'deletion_requested', deletionAt: at })
  })

  it('is read-only while paused, and ignores a plan this service does not sell', () => {
    expect(billingAccess(snapshot({ subscriptionStatus: 'paused', planId: 'holding' }), now, settings)).toMatchObject({ phase: 'read_only', reason: 'paused' })
    expect(billingAccess(snapshot({ subscriptionStatus: 'active', planId: 'toString' }), now, settings)).toMatchObject({ planId: null, companyLimit: 0 })
  })

  it('knows which statuses still bill and which ended', () => {
    expect(['active', 'trialing', 'past_due', 'unpaid', 'paused'].every(hasLiveSubscription)).toBe(true)
    expect([null, 'canceled', 'incomplete', 'incomplete_expired'].some(hasLiveSubscription)).toBe(false)
    expect(['canceled', 'incomplete_expired'].every(hasEndedSubscription)).toBe(true)
    expect(hasEndedSubscription('active')).toBe(false)
  })
})

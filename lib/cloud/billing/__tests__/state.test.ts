/**
 * Billing state machine (lib/cloud/billing/state.ts): every transition, from
 * the stored snapshot and the time alone.
 */

import { describe, expect, it } from 'vitest'
import { addDays, billingAccess, daysLeft, hasLiveSubscription, type BillingSnapshot } from '../state'

const settings = { graceDays: 14, trialCompanyLimit: 3 }
const signup = new Date('2026-10-01T10:00:00Z')
const trialEndsAt = addDays(signup, 30)

const snapshot = (over: Partial<BillingSnapshot> = {}): BillingSnapshot => ({
  trialEndsAt,
  subscriptionStatus: null,
  planId: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  subscriptionEndedAt: null,
  paymentFailedAt: null,
  ...over,
})

describe('billing state', () => {
  describe('without a subscription (free trial, no card)', () => {
    it('is a writable trial with the trial company limit until trialEndsAt', () => {
      const access = billingAccess(snapshot(), addDays(signup, 29), settings)
      expect(access).toMatchObject({ phase: 'trial', writable: true, reason: null, planId: null, companyLimit: 3, trialEndsAt })
      expect(daysLeft(trialEndsAt, addDays(signup, 29))).toBe(1)
    })

    it('enters the grace period when the trial ends, then turns read-only', () => {
      expect(billingAccess(snapshot(), trialEndsAt, settings)).toMatchObject({
        phase: 'grace',
        writable: true,
        reason: 'trial_ended',
        readOnlyAt: addDays(trialEndsAt, 14),
      })
      expect(billingAccess(snapshot(), addDays(trialEndsAt, 14), settings)).toMatchObject({
        phase: 'read_only',
        writable: false,
        reason: 'trial_ended',
        companyLimit: 0,
      })
    })

    it('treats a first payment not completed (incomplete) like no subscription', () => {
      expect(billingAccess(snapshot({ subscriptionStatus: 'incomplete', planId: 'holding' }), addDays(signup, 2), settings).phase).toBe('trial')
      expect(billingAccess(snapshot({ subscriptionStatus: 'incomplete' }), addDays(trialEndsAt, 20), settings).phase).toBe('read_only')
    })
  })

  describe('with a subscription', () => {
    it('is active with the limit of its plan, whatever the trial says', () => {
      const access = billingAccess(snapshot({ subscriptionStatus: 'active', planId: 'holding' }), addDays(trialEndsAt, 400), settings)
      expect(access).toMatchObject({ phase: 'active', writable: true, planId: 'holding', companyLimit: 5, endsAt: null })
      expect(billingAccess(snapshot({ subscriptionStatus: 'trialing', planId: 'essentiel' }), signup, settings)).toMatchObject({
        phase: 'active',
        companyLimit: 1,
      })
    })

    it('tells when a cancelled subscription ends, and stays writable until then', () => {
      const end = new Date('2026-12-01T00:00:00Z')
      const access = billingAccess(
        snapshot({ subscriptionStatus: 'active', planId: 'cabinet', cancelAtPeriodEnd: true, currentPeriodEnd: end }),
        addDays(signup, 40),
        settings,
      )
      expect(access).toMatchObject({ phase: 'active', writable: true, endsAt: end, companyLimit: 100 })
    })

    it('gives a grace period from the first failed payment, then turns read-only (past_due, unpaid)', () => {
      const failed = new Date('2027-01-05T08:00:00Z')
      for (const status of ['past_due', 'unpaid']) {
        const s = snapshot({ subscriptionStatus: status, planId: 'holding', paymentFailedAt: failed })
        expect(billingAccess(s, addDays(failed, 13), settings)).toMatchObject({
          phase: 'grace',
          writable: true,
          reason: 'payment_failed',
          readOnlyAt: addDays(failed, 14),
          companyLimit: 5,
        })
        expect(billingAccess(s, addDays(failed, 14), settings)).toMatchObject({ phase: 'read_only', writable: false, reason: 'payment_failed' })
      }
    })

    it('counts the grace of an unknown failure date from the period end', () => {
      const periodEnd = new Date('2027-02-01T00:00:00Z')
      const s = snapshot({ subscriptionStatus: 'past_due', currentPeriodEnd: periodEnd })
      expect(billingAccess(s, addDays(periodEnd, 15), settings).phase).toBe('read_only')
    })

    it('gives a grace period after the subscription ended, then turns read-only', () => {
      const ended = new Date('2027-03-01T00:00:00Z')
      const s = snapshot({ subscriptionStatus: 'canceled', planId: 'essentiel', subscriptionEndedAt: ended })
      expect(billingAccess(s, addDays(ended, 1), settings)).toMatchObject({ phase: 'grace', reason: 'subscription_ended', readOnlyAt: addDays(ended, 14) })
      expect(billingAccess(s, addDays(ended, 14), settings)).toMatchObject({ phase: 'read_only', writable: false })
      expect(billingAccess(snapshot({ subscriptionStatus: 'incomplete_expired', subscriptionEndedAt: ended }), addDays(ended, 30), settings).phase).toBe(
        'read_only',
      )
    })

    it('keeps the trial when a subscription is cancelled during it, and its grace after', () => {
      const s = snapshot({ subscriptionStatus: 'canceled', subscriptionEndedAt: addDays(signup, 3) })
      expect(billingAccess(s, addDays(signup, 10), settings).phase).toBe('trial')
      expect(billingAccess(s, addDays(trialEndsAt, 1), settings)).toMatchObject({ phase: 'grace', readOnlyAt: addDays(trialEndsAt, 14) })
    })

    it('is read-only while paused', () => {
      expect(billingAccess(snapshot({ subscriptionStatus: 'paused', planId: 'holding' }), signup, settings)).toMatchObject({
        phase: 'read_only',
        writable: false,
        reason: 'paused',
      })
    })

    it('ignores a plan id this instance does not sell', () => {
      const access = billingAccess(snapshot({ subscriptionStatus: 'active', planId: 'unknown' }), signup, settings)
      expect(access).toMatchObject({ planId: null, companyLimit: 3 })
    })
  })

  it('knows which statuses already pay (a second checkout is refused)', () => {
    expect(['active', 'trialing', 'past_due', 'unpaid', 'paused'].every(hasLiveSubscription)).toBe(true)
    expect([null, 'canceled', 'incomplete', 'incomplete_expired'].some(hasLiveSubscription)).toBe(false)
  })
})

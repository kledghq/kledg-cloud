/**
 * Banner notice of the billing state (lib/cloud/billing/notice.ts): one
 * French sentence and one link per state.
 */

import { describe, expect, it } from 'vitest'
import { billingNotice, frenchDay } from '../notice'
import { addDays, billingAccess, type BillingSnapshot } from '../state'

const now = new Date('2026-11-10T09:00:00Z')
const settings = { graceDays: 14, trialCompanyLimit: 3 }
const snap = (over: Partial<BillingSnapshot>): BillingSnapshot => ({
  trialEndsAt: addDays(now, 12),
  subscriptionStatus: null,
  planId: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  subscriptionEndedAt: null,
  paymentFailedAt: null,
  ...over,
})
const notice = (over: Partial<BillingSnapshot>, deletion: Date | null = null) => billingNotice(billingAccess(snap(over), now, settings), deletion, now)

describe('billing notice', () => {
  it('counts the trial days left', () => {
    expect(notice({})).toEqual({
      tone: 'info',
      text: 'Essai gratuit : il vous reste 12 jours.',
      link: { label: 'Choisir une offre', href: '/settings/billing' },
    })
    expect(notice({ trialEndsAt: addDays(now, 0.5) })?.text).toBe('Essai gratuit : dernier jour.')
  })

  it('warns before the account turns read-only, with the date', () => {
    expect(notice({ trialEndsAt: addDays(now, -2) })).toEqual({
      tone: 'warning',
      text: `Votre essai gratuit est terminé : votre compte passera en lecture seule le ${frenchDay(addDays(now, 12))}.`,
      link: { label: 'Choisir une offre', href: '/settings/billing' },
    })
    expect(notice({ subscriptionStatus: 'past_due', paymentFailedAt: addDays(now, -1), trialEndsAt: addDays(now, -60) })).toMatchObject({
      tone: 'warning',
      text: expect.stringMatching(/^Le paiement de votre abonnement a échoué : mettez à jour votre moyen de paiement avant le /),
      link: { label: 'Gérer mon abonnement', href: '/settings/billing' },
    })
  })

  it('explains a read-only account and keeps its data available', () => {
    expect(notice({ trialEndsAt: addDays(now, -30) })?.text).toBe(
      'Votre compte est en lecture seule : votre essai gratuit est terminé. Choisissez une offre pour créer des sociétés et reprendre la saisie. Vos données restent consultables et exportables.',
    )
  })

  it('says nothing for an active subscription, and when it ends once cancelled', () => {
    expect(notice({ subscriptionStatus: 'active', planId: 'holding' })).toBeNull()
    expect(
      notice({ subscriptionStatus: 'active', planId: 'holding', cancelAtPeriodEnd: true, currentPeriodEnd: new Date('2027-01-15T00:00:00Z') })?.text,
    ).toBe('Votre abonnement prend fin le 15 janvier 2027.')
  })

  it('puts a scheduled deletion first', () => {
    expect(notice({ subscriptionStatus: 'active' }, new Date('2026-12-10T10:00:00Z'))).toEqual({
      tone: 'warning',
      text: 'La suppression de votre compte est programmée le 10 décembre 2026.',
      link: { label: 'Annuler ou exporter mes données', href: '/settings/data' },
    })
  })
})

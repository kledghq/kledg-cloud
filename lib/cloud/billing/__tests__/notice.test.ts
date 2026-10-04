/**
 * Banner notice of the billing state (lib/cloud/billing/notice.ts): one
 * French sentence and one link per state.
 */

import { describe, expect, it } from 'vitest'
import { billingNotice, frenchDay } from '../notice'
import { addDays, billingAccess, type BillingSnapshot } from '../state'

const now = new Date('2026-11-10T09:00:00Z')
const settings = { graceDays: 14, retrievalDays: 30 }
const snap = (over: Partial<BillingSnapshot>): BillingSnapshot => ({
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
const notice = (over: Partial<BillingSnapshot>, hasCompanies = true) => billingNotice(billingAccess(snap(over), now, settings), now, { hasCompanies })

describe('billing notice', () => {
  it('tells a new user how to start, and stays quiet for members invited elsewhere', () => {
    expect(notice({}, false)).toEqual({
      tone: 'info',
      text: 'Essai gratuit de 30 jours, sans carte bancaire : choisissez une offre pour créer votre première société.',
      link: { label: 'Choisir une offre', href: '/settings/billing' },
    })
    expect(notice({}, true)).toBeNull()
  })

  it('counts the trial days left and asks for a payment method to go on', () => {
    expect(notice({ subscriptionStatus: 'trialing', planId: 'holding', trialEnd: addDays(now, 12) })).toEqual({
      tone: 'info',
      text: "Essai gratuit : il vous reste 12 jours. Ajoutez un moyen de paiement pour continuer après l'essai.",
      link: { label: 'Gérer mon abonnement', href: '/settings/billing' },
    })
    expect(notice({ subscriptionStatus: 'trialing', trialEnd: addDays(now, 0.5) })?.text).toMatch(/^Essai gratuit : dernier jour\./)
  })

  it('warns after a failed payment with the read-only date, then explains the read-only account', () => {
    expect(notice({ subscriptionStatus: 'past_due', paymentFailedAt: addDays(now, -2) })).toEqual({
      tone: 'warning',
      text: `Le paiement de votre abonnement a échoué : réglez-le avant le ${frenchDay(addDays(now, 12))}, date à laquelle votre compte passera en lecture seule.`,
      link: { label: 'Gérer mon abonnement', href: '/settings/billing' },
    })
    expect(notice({ subscriptionStatus: 'past_due', paymentFailedAt: addDays(now, -20) })?.text).toBe(
      'Votre compte est en lecture seule : le paiement de votre abonnement a échoué. Choisissez une offre pour créer des sociétés et reprendre la saisie. Vos données restent consultables et exportables.',
    )
  })

  it('gives the end of the retrieval period once the contract ended', () => {
    expect(notice({ subscriptionStatus: 'canceled', subscriptionEndedAt: new Date('2026-11-05T00:00:00Z') })).toEqual({
      tone: 'warning',
      text: "Votre abonnement a pris fin : vos données restent consultables et exportables jusqu'au 5 décembre 2026, puis elles seront supprimées.",
      link: { label: 'Exporter mes données', href: '/settings/data' },
    })
  })

  it('announces a requested deletion first, and the end of a cancelled subscription', () => {
    expect(notice({ subscriptionStatus: 'active', deletionScheduledFor: new Date('2026-12-10T10:00:00Z'), deletionReason: 'requested' })).toEqual({
      tone: 'warning',
      text: "La suppression de votre compte est programmée le 10 décembre 2026 : il est en lecture seule d'ici là.",
      link: { label: 'Annuler ou exporter mes données', href: '/settings/data' },
    })
    expect(notice({ subscriptionStatus: 'active', planId: 'holding' })).toBeNull()
    expect(notice({ subscriptionStatus: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: new Date('2027-01-15T00:00:00Z') })?.text).toBe(
      'Votre abonnement prend fin le 15 janvier 2027.',
    )
  })
})

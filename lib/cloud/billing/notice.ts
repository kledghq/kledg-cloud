/**
 * The one-line notice of the banner above every page (InstanceBanner slot):
 * the trial, a payment to fix, an end of subscription, a read-only account
 * or a deletion in progress. Pure: tested on plain values.
 */

import { CLOUD_PATHS } from '../config'
import { readOnlyMessage } from '../messages'
import type { BillingAccess } from './state'
import { daysLeft } from './state'

export interface BillingNotice {
  tone: 'info' | 'warning'
  text: string
  link: { label: string; href: string }
}

/** "12 mars 2027" (Paris calendar day). */
export function frenchDay(date: Date): string {
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' }).format(date)
}

const PLANS_LINK = { label: 'Choisir une offre', href: CLOUD_PATHS.billing }
const MANAGE_LINK = { label: 'Gérer mon abonnement', href: CLOUD_PATHS.billing }

export function billingNotice(access: BillingAccess, deletionScheduledFor: Date | null, now: Date): BillingNotice | null {
  if (deletionScheduledFor) {
    return {
      tone: 'warning',
      text: `La suppression de votre compte est programmée le ${frenchDay(deletionScheduledFor)}.`,
      link: { label: 'Annuler ou exporter mes données', href: CLOUD_PATHS.data },
    }
  }
  switch (access.phase) {
    case 'trial': {
      const days = daysLeft(access.trialEndsAt ?? now, now)
      return {
        tone: 'info',
        text: `Essai gratuit : ${days <= 1 ? 'dernier jour' : `il vous reste ${days} jours`}.`,
        link: PLANS_LINK,
      }
    }
    case 'grace': {
      const when = frenchDay(access.readOnlyAt ?? now)
      if (access.reason === 'payment_failed') {
        return {
          tone: 'warning',
          text: `Le paiement de votre abonnement a échoué : mettez à jour votre moyen de paiement avant le ${when}, date à laquelle votre compte passera en lecture seule.`,
          link: MANAGE_LINK,
        }
      }
      const why = access.reason === 'subscription_ended' ? 'Votre abonnement a pris fin' : 'Votre essai gratuit est terminé'
      return { tone: 'warning', text: `${why} : votre compte passera en lecture seule le ${when}.`, link: PLANS_LINK }
    }
    case 'read_only':
      return { tone: 'warning', text: readOnlyMessage(access), link: access.reason === 'payment_failed' ? MANAGE_LINK : PLANS_LINK }
    case 'active':
      return access.endsAt
        ? { tone: 'info', text: `Votre abonnement prend fin le ${frenchDay(access.endsAt)}.`, link: MANAGE_LINK }
        : null
  }
}

/**
 * The one-line notice of the banner above every page (InstanceBanner slot):
 * the trial, a payment to fix, an end of subscription, a read-only account,
 * the retrieval period or a deletion in progress. Pure: tested on plain
 * values.
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
const DATA_LINK = { label: 'Exporter mes données', href: CLOUD_PATHS.data }

/**
 * `hasCompanies`: whether the user belongs to any company. A user without a
 * subscription (a new account, or a member invited elsewhere) is only told
 * how to start when they have no company at all.
 */
export function billingNotice(access: BillingAccess, now: Date, options: { hasCompanies: boolean }): BillingNotice | null {
  switch (access.phase) {
    case 'none':
      return options.hasCompanies
        ? null
        : { tone: 'info', text: 'Essai gratuit de 30 jours, sans carte bancaire : choisissez une offre pour créer votre première société.', link: PLANS_LINK }
    case 'trial': {
      const days = daysLeft(access.trialEndsAt ?? now, now)
      return {
        tone: 'info',
        text: `Essai gratuit : ${days <= 1 ? 'dernier jour' : `il vous reste ${days} jours`}. Ajoutez un moyen de paiement pour continuer après l'essai.`,
        link: MANAGE_LINK,
      }
    }
    case 'grace':
      return {
        tone: 'warning',
        text: `Le paiement de votre abonnement a échoué : réglez-le avant le ${frenchDay(access.readOnlyAt ?? now)}, date à laquelle votre compte passera en lecture seule.`,
        link: MANAGE_LINK,
      }
    case 'read_only':
      if (access.reason === 'deletion_requested') {
        return {
          tone: 'warning',
          text: `La suppression de votre compte est programmée le ${frenchDay(access.deletionAt ?? now)} : il est en lecture seule d'ici là.`,
          link: { label: 'Annuler ou exporter mes données', href: CLOUD_PATHS.data },
        }
      }
      if (access.reason === 'contract_ended') {
        return {
          tone: 'warning',
          text: `Votre abonnement a pris fin : vos données restent consultables et exportables jusqu'au ${frenchDay(access.retrievalEndsAt ?? now)}, puis elles seront supprimées.`,
          link: DATA_LINK,
        }
      }
      return { tone: 'warning', text: readOnlyMessage(access), link: access.reason === 'payment_failed' || access.reason === 'billing_outdated' ? MANAGE_LINK : PLANS_LINK }
    case 'active':
      return access.endsAt ? { tone: 'info', text: `Votre abonnement prend fin le ${frenchDay(access.endsAt)}.`, link: MANAGE_LINK } : null
  }
}

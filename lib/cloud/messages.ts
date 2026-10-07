/**
 * French messages of the billing restrictions (pure): shown in refusals
 * (lib/cloud/enforcement.ts) and in the banner (lib/cloud/billing/notice.ts).
 */

import { companyLimitLabel, PLANS } from './billing/plans'
import type { BillingAccess, BillingReason } from './billing/state'

const REASONS: Record<BillingReason, string> = {
  no_subscription: "vous n'avez pas encore d'offre",
  payment_failed: 'le paiement de votre abonnement a échoué',
  contract_ended: 'votre abonnement a pris fin',
  paused: 'votre abonnement est suspendu',
  deletion_requested: 'la suppression de votre compte est programmée',
  billing_outdated: "la fin de votre essai ou de votre abonnement n'a pas encore été confirmée par notre prestataire de paiement",
}

const OWNER_REASONS: Record<BillingReason, string> = {
  no_subscription: "son titulaire n'a pas d'offre en cours",
  payment_failed: "le paiement de l'abonnement de son titulaire a échoué",
  contract_ended: "l'abonnement de son titulaire a pris fin",
  paused: "l'abonnement de son titulaire est suspendu",
  deletion_requested: 'la suppression du compte de son titulaire est programmée',
  billing_outdated: "la fin de l'essai ou de l'abonnement de son titulaire n'a pas encore été confirmée par notre prestataire de paiement",
}

/** Refusal of a first company: the trial starts by choosing a plan. */
export const START_TRIAL_MESSAGE =
  "Choisissez une offre pour créer votre première société : l'essai gratuit de 30 jours démarre sans carte bancaire et ne se transforme pas en abonnement payant sans votre accord."

/** Why an account is read-only, as its owner reads it. */
export function readOnlyMessage(access: BillingAccess): string {
  const why = REASONS[access.reason ?? 'no_subscription']
  if (access.reason === 'deletion_requested') {
    return `Votre compte est en lecture seule : ${why}. Vous pouvez encore l'annuler et exporter vos données depuis la page Données et compte.`
  }
  if (access.reason === 'billing_outdated') {
    return `Votre compte est en lecture seule : ${why}. Elle l'est en général sous 24 heures ; vous pouvez aussi vérifier votre abonnement depuis la page Facturation. Vos données restent consultables et exportables.`
  }
  return `Votre compte est en lecture seule : ${why}. Choisissez une offre pour créer des sociétés et reprendre la saisie. Vos données restent consultables et exportables.`
}

/** Why a company is read-only, as any of its members reads it. */
export function companyReadOnlyMessage(access: BillingAccess): string {
  const why = OWNER_REASONS[access.reason ?? 'no_subscription']
  return `Cette société est en lecture seule : ${why}. Ses données restent consultables et exportables (FEC, export complet). Le titulaire du compte peut rétablir l'accès depuis sa page Facturation.`
}

/** Why a company beyond the limit of its owner's plan is read-only (after a switch to a smaller plan), as any member reads it. */
export function companyOverLimitMessage(access: BillingAccess): string {
  const name = access.planId ? PLANS[access.planId].name : ''
  return `Cette société est en lecture seule : l'offre ${name} de son titulaire couvre ${companyLimitLabel(access.companyLimit)} et son compte en possède davantage. Ses données restent consultables et exportables (FEC, export complet). Le titulaire du compte peut passer à une offre plus large depuis sa page Facturation.`
}

/** Why the plan forbids one more company. */
export function companyLimitMessage(access: BillingAccess, count: number): string {
  const name = access.planId ? PLANS[access.planId].name : ''
  const scope = access.phase === 'trial' ? `Votre essai de l'offre ${name} permet` : `Votre offre ${name} permet`
  // Cabinet has no larger plan: its companies beyond the 25 included are billed, once the trial is paid.
  const way =
    access.phase === 'trial' && access.planId === 'cabinet'
      ? "Les sociétés suivantes, facturées à l'unité, se créent une fois l'abonnement payé, à la fin de l'essai."
      : 'Passez à une offre plus large pour créer une nouvelle société.'
  return `${scope} ${companyLimitLabel(access.companyLimit)} : vous en avez déjà ${count}. ${way}`
}

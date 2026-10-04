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
}

const OWNER_REASONS: Record<BillingReason, string> = {
  no_subscription: "son titulaire n'a pas d'offre en cours",
  payment_failed: "le paiement de l'abonnement de son titulaire a échoué",
  contract_ended: "l'abonnement de son titulaire a pris fin",
  paused: "l'abonnement de son titulaire est suspendu",
  deletion_requested: 'la suppression du compte de son titulaire est programmée',
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
  return `Votre compte est en lecture seule : ${why}. Choisissez une offre pour créer des sociétés et reprendre la saisie. Vos données restent consultables et exportables.`
}

/** Why a company is read-only, as any of its members reads it. */
export function companyReadOnlyMessage(access: BillingAccess): string {
  const why = OWNER_REASONS[access.reason ?? 'no_subscription']
  return `Cette société est en lecture seule : ${why}. Ses données restent consultables et exportables (FEC, export complet). Le titulaire du compte peut rétablir l'accès depuis sa page Facturation.`
}

/** Why the plan forbids one more company. */
export function companyLimitMessage(access: BillingAccess, count: number): string {
  const name = access.planId ? PLANS[access.planId].name : ''
  const scope = access.phase === 'trial' ? `Votre essai de l'offre ${name} permet` : `Votre offre ${name} permet`
  return `${scope} ${companyLimitLabel(access.companyLimit)} : vous en avez déjà ${count}. Passez à une offre plus large pour créer une nouvelle société.`
}

/**
 * French messages of the billing restrictions (pure): shown in refusals
 * (lib/cloud/enforcement.ts) and in the banner (lib/cloud/billing/notice.ts).
 */

import { companyLimitLabel, PLANS } from './billing/plans'
import type { BillingAccess, BillingReason } from './billing/state'

const REASONS: Record<BillingReason, string> = {
  trial_ended: 'votre essai gratuit est terminé',
  payment_failed: 'le paiement de votre abonnement a échoué',
  subscription_ended: 'votre abonnement a pris fin',
  paused: 'votre abonnement est suspendu',
}

const OWNER_REASONS: Record<BillingReason, string> = {
  trial_ended: "l'essai gratuit de son titulaire est terminé",
  payment_failed: "le paiement de l'abonnement de son titulaire a échoué",
  subscription_ended: "l'abonnement de son titulaire a pris fin",
  paused: "l'abonnement de son titulaire est suspendu",
}

/** Why an account is read-only, as its owner reads it. */
export function readOnlyMessage(access: BillingAccess): string {
  const why = REASONS[access.reason ?? 'trial_ended']
  return `Votre compte est en lecture seule : ${why}. Choisissez une offre pour créer des sociétés et reprendre la saisie. Vos données restent consultables et exportables.`
}

/** Why a company is read-only, as any of its members reads it. */
export function companyReadOnlyMessage(access: BillingAccess): string {
  const why = OWNER_REASONS[access.reason ?? 'trial_ended']
  return `Cette société est en lecture seule : ${why}. Ses données restent consultables et exportables (FEC, export complet). Le titulaire du compte peut choisir une offre depuis sa page Facturation.`
}

/** Why the plan forbids one more company. */
export function companyLimitMessage(access: BillingAccess, count: number): string {
  const scope = access.planId ? `Votre offre ${PLANS[access.planId].name} permet` : "Pendant l'essai gratuit, vous pouvez créer"
  return `${scope} ${companyLimitLabel(access.companyLimit)} : vous en avez déjà ${count}. Choisissez une offre plus large pour créer une nouvelle société.`
}

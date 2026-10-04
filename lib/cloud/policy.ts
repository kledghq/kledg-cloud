/**
 * Instance policy of Kledg Cloud (plugged into Kledg by
 * lib/instance/policy.ts). Pure: no database, no Node APIs, the request
 * proxy imports it. The checks that read the database are in
 * lib/cloud/enforcement.ts, loaded lazily by the policy.
 *
 * Without KLEDG_CLOUD_MODE=true every answer is Kledg's own.
 */

import type { InstanceAction, InstanceActor, RateLimitRule } from '@/lib/instance/types'
import { CLOUD_PATHS, isCloudMode } from './config'

/** Kledg's default refusal message (lib/instance/policy.ts of Kledg). */
export const DEFAULT_REFUSAL = "Cette action est désactivée sur cette instance. Contactez l'administrateur de l'instance."

/**
 * Actions the hosted service refuses, with the French reason. Account
 * deletion goes through the "Données et compte" page: it waits for a grace
 * period and handles the books kept for legal retention
 * (lib/cloud/account/account-deletion.service.ts).
 */
export const CLOUD_REFUSED: Partial<Record<InstanceAction, string>> = {
  'delete-account':
    "Supprimez votre compte depuis la page Données et compte : la suppression a lieu après un délai pendant lequel vous pouvez l'annuler, et vos livres comptables y sont traités selon vos choix.",
}

export async function cloudIsActionAllowed(action: InstanceAction, actor: InstanceActor | null): Promise<boolean> {
  void actor
  return !isCloudMode() || !(action in CLOUD_REFUSED)
}

export function cloudRefusalMessage(action: InstanceAction): string {
  return (isCloudMode() && CLOUD_REFUSED[action]) || DEFAULT_REFUSAL
}

/**
 * Routes of the hosted service that authenticate requests themselves. They
 * answer 404 outside cloud mode.
 */
export const CLOUD_SELF_AUTHENTICATED_API_ROUTES: Readonly<Record<string, string>> = {
  '/api/signup': 'Public sign-up: rate limited per client IP and per address, same answer whether the address has an account or not',
  '/api/billing/webhook': 'Stripe webhook: Stripe-Signature HMAC checked with STRIPE_WEBHOOK_SECRET, idempotent per event id',
  '/api/cron/cloud-maintenance': 'Vercel cron: requires the CRON_SECRET bearer token',
}

/** Pages of the hosted service that open without a session. */
export const CLOUD_PUBLIC_PAGES: readonly string[] = [CLOUD_PATHS.signup]

/** Rate limits of the hosted service's own routes (enforceRateLimit, lib/rate-limit.ts). */
export const CLOUD_RATE_LIMITS = {
  /** Sign-up attempts, per client IP. */
  'cloud-signup-ip': { window: 3600, max: 10, message: 'Trop de créations de compte depuis cette connexion. Réessayez dans une heure.' },
  /** Sign-up attempts, per address (whether it has an account or not). */
  'cloud-signup-email': { window: 3600, max: 3, message: 'Trop de demandes pour cette adresse. Réessayez dans une heure.' },
  /** Calls to Stripe (checkout, customer portal, invoices), per user. */
  'cloud-billing': { window: 60, max: 10, message: 'Trop de requêtes de facturation en une minute. Patientez une minute.' },
  /** Full data exports, per user. */
  'cloud-export': { window: 3600, max: 10, message: "Trop d'exports complets en une heure. Réessayez plus tard." },
  /** Account deletion requests and cancellations, per user. */
  'cloud-account-deletion': { window: 900, max: 5, message: 'Trop de tentatives. Réessayez dans quelques minutes.' },
  /** Acceptance of new terms, per user. */
  'cloud-terms': { window: 60, max: 10, message: 'Trop de tentatives. Patientez une minute.' },
  /** Operator console actions, per instance administrator. */
  'cloud-operator': { window: 60, max: 30, message: 'Trop de modifications en une minute. Patientez une minute.' },
} as const satisfies Record<string, RateLimitRule>

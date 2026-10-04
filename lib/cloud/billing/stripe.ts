/**
 * The Stripe client of Kledg Cloud (official SDK). Secrets come from the
 * environment only: STRIPE_SECRET_KEY for the API, STRIPE_WEBHOOK_SECRET
 * for webhook signatures (docs/cloud.md). The API version is pinned to the
 * one the installed SDK is typed for, so a Stripe dashboard default can
 * never change the shape of the objects this code reads.
 *
 * Tests build the real SDK on a mocked fetch (createStripe): no request ever
 * leaves the machine and no key is needed.
 */

import Stripe from 'stripe'
import { ExternalServiceError } from '@/lib/accounting/errors'

/** Stripe API version this code is written against (stripe-node 23). */
export const STRIPE_API_VERSION = '2026-09-30.endive' as const

type Env = Record<string, string | undefined>

/** Secret API keys as Stripe issues them (sk_live_, sk_test_, restricted rk_). */
const SECRET_KEY = /^(sk|rk)_(live|test)_[A-Za-z0-9]{16,}$/

export function stripeSecretKey(env: Env = process.env): string | null {
  const key = env.STRIPE_SECRET_KEY?.trim()
  return key && SECRET_KEY.test(key) ? key : null
}

export function stripeWebhookSecret(env: Env = process.env): string | null {
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim()
  return secret && secret.startsWith('whsec_') && secret.length > 16 ? secret : null
}

/** Whether billing can reach Stripe (the secret key is set). */
export function isStripeConfigured(env: Env = process.env): boolean {
  return stripeSecretKey(env) !== null
}

/** A Stripe client on `fetchFn` (the global fetch in production, a mock in tests). */
export function createStripe(apiKey: string, fetchFn: typeof fetch = fetch): Stripe {
  return new Stripe(apiKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(fetchFn),
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: 'Kledg Cloud', url: 'https://www.kledg.com' },
  })
}

let client: Stripe | null = null

/** The shared client; a French 502 when Stripe is not configured on this deployment. */
export function getStripe(): Stripe {
  const key = stripeSecretKey()
  if (!key) throw new ExternalServiceError("La facturation n'est pas encore disponible. Réessayez plus tard ou contactez le support.")
  client ??= createStripe(key)
  return client
}

/** Webhook signatures are checked with the SDK's static helpers: no API key involved. */
export const stripeWebhooks = Stripe.webhooks

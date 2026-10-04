/**
 * Paying for Kledg Cloud through Stripe-hosted pages: Checkout to subscribe,
 * the Customer Portal to change plan, card or billing details and to
 * cancel, and the list of invoices. Card data never reaches Kledg.
 *
 * Checkout sessions collect the billing address and VAT number (tax id
 * collection) and compute VAT with Stripe Tax (automatic_tax). An account
 * still in its trial keeps it: the subscription starts billing when the
 * trial ends. The subscription itself reaches the account through the
 * webhook (stripe-webhook.service.ts), never through the success page.
 */

import type Stripe from 'stripe'
import { prisma } from '@/lib/prisma'
import { ConflictError, ExternalServiceError, ValidationError } from '@/lib/accounting/errors'
import { enforceRateLimit } from '@/lib/rate-limit'
import { getAppUrl } from '@/lib/config'
import { logger } from '@/lib/logger'
import type { CurrentUser } from '@/lib/session'
import { CLOUD_PATHS } from '../config'
import { ensureBillingAccount, findBillingAccount } from './billing-account.service'
import { BILLING_INTERVALS, PLAN_IDS, priceIdFor } from './plans'
import { hasLiveSubscription } from './state'
import { getStripe } from './stripe'
import { z } from 'zod'

export const CheckoutSchema = z.object({
  plan: z.enum(PLAN_IDS, { error: 'Offre inconnue.' }),
  interval: z.enum(BILLING_INTERVALS, { error: 'Période de facturation inconnue.' }).default('month'),
})
export type CheckoutInput = z.infer<typeof CheckoutSchema>

/** Stripe requires a trial end at least 48 hours ahead; a shorter remainder is not worth keeping. */
const MIN_TRIAL_LEFT_MS = 49 * 60 * 60 * 1000

function stripeFailure(error: unknown, action: string): never {
  logger.error(`Stripe ${action} failed`, { error })
  throw new ExternalServiceError("Stripe n'a pas répondu. Réessayez dans quelques instants.")
}

/** The account's Stripe customer, created on first use (idempotent: same key, same customer). */
async function ensureCustomer(stripe: Stripe, accountId: string, user: CurrentUser): Promise<string> {
  const account = await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { id: accountId } })
  if (account.stripeCustomerId) return account.stripeCustomerId
  const customer = await stripe.customers
    .create(
      {
        email: user.email,
        name: user.name ?? undefined,
        preferred_locales: ['fr'],
        metadata: { billing_account_id: accountId },
      },
      { idempotencyKey: `kledg-cloud-customer-${accountId}` },
    )
    .catch((error: unknown) => stripeFailure(error, 'customer creation'))
  // Two checkouts at once get the same customer (idempotency key); only the first write lands.
  await prisma.cloudBillingAccount.updateMany({ where: { id: accountId, stripeCustomerId: null }, data: { stripeCustomerId: customer.id } })
  return (await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { id: accountId } })).stripeCustomerId ?? customer.id
}

/** A Checkout session to subscribe to `plan`; answers the Stripe-hosted URL to open. */
export async function createCheckoutSession(user: CurrentUser, input: CheckoutInput, stripe: Stripe = getStripe(), now: Date = new Date()): Promise<{ url: string }> {
  await enforceRateLimit('cloud-billing', user.id)
  const price = priceIdFor(input.plan, input.interval)
  if (!price) throw new ValidationError("Cette offre n'est pas disponible pour cette période de facturation.")
  const account = await ensureBillingAccount(user.id, now)
  if (account.deletionScheduledFor) {
    throw new ConflictError('La suppression de votre compte est programmée. Annulez-la depuis la page Données et compte pour vous abonner.')
  }
  if (hasLiveSubscription(account.subscriptionStatus)) {
    throw new ConflictError('Vous avez déjà un abonnement. Changez d’offre ou de moyen de paiement depuis « Gérer mon abonnement ».')
  }

  const customer = await ensureCustomer(stripe, account.id, user)
  const base = getAppUrl()
  const keepTrial = account.trialEndsAt.getTime() - now.getTime() >= MIN_TRIAL_LEFT_MS
  const session = await stripe.checkout.sessions
    .create({
      mode: 'subscription',
      customer,
      client_reference_id: account.id,
      line_items: [{ price, quantity: 1 }],
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      // Required with an existing customer for tax ids and the address Stripe Tax needs.
      customer_update: { address: 'auto', name: 'auto' },
      billing_address_collection: 'required',
      allow_promotion_codes: true,
      locale: 'fr',
      subscription_data: {
        metadata: { billing_account_id: account.id },
        ...(keepTrial ? { trial_end: Math.floor(account.trialEndsAt.getTime() / 1000) } : {}),
      },
      success_url: `${base}${CLOUD_PATHS.billing}?checkout=success`,
      cancel_url: `${base}${CLOUD_PATHS.billing}?checkout=cancel`,
    })
    .catch((error: unknown) => stripeFailure(error, 'checkout session'))
  if (!session.url) stripeFailure(new Error('Checkout session without url'), 'checkout session')
  return { url: session.url }
}

/** A Customer Portal session (plan, payment method, billing details, invoices, cancellation). */
export async function createPortalSession(user: CurrentUser, stripe: Stripe = getStripe()): Promise<{ url: string }> {
  await enforceRateLimit('cloud-billing', user.id)
  const account = await findBillingAccount(user.id)
  if (!account?.stripeCustomerId) throw new ConflictError("Vous n'avez pas encore d'abonnement : choisissez d'abord une offre.")
  const session = await stripe.billingPortal.sessions
    .create({ customer: account.stripeCustomerId, return_url: `${getAppUrl()}${CLOUD_PATHS.billing}`, locale: 'fr' })
    .catch((error: unknown) => stripeFailure(error, 'portal session'))
  return { url: session.url }
}

export interface InvoiceSummary {
  id: string
  number: string | null
  /** ISO day of issue. */
  date: string
  totalCents: number
  currency: string
  status: string | null
  /** Stripe-hosted page and PDF of the invoice. */
  hostedUrl: string | null
  pdfUrl: string | null
}

/** Stripe-hosted invoice links, kept only when they point to Stripe. */
function stripeUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const host = new URL(url).hostname
    return new URL(url).protocol === 'https:' && (host === 'stripe.com' || host.endsWith('.stripe.com')) ? url : null
  } catch {
    return null
  }
}

/** The account's last 24 invoices, newest first (empty without a Stripe customer). */
export async function listInvoices(user: CurrentUser, stripe: Stripe = getStripe()): Promise<InvoiceSummary[]> {
  const account = await findBillingAccount(user.id)
  if (!account?.stripeCustomerId) return []
  await enforceRateLimit('cloud-billing', user.id)
  const invoices = await stripe.invoices
    .list({ customer: account.stripeCustomerId, limit: 24 })
    .catch((error: unknown) => stripeFailure(error, 'invoice list'))
  return invoices.data
    .filter((invoice) => invoice.status !== 'draft')
    .map((invoice) => ({
      id: invoice.id ?? '',
      number: invoice.number,
      date: new Date(invoice.created * 1000).toISOString().slice(0, 10),
      totalCents: invoice.total,
      currency: invoice.currency,
      status: invoice.status,
      hostedUrl: stripeUrl(invoice.hosted_invoice_url),
      pdfUrl: stripeUrl(invoice.invoice_pdf),
    }))
}

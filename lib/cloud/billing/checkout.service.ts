/**
 * Paying for Kledg Cloud through Stripe-hosted pages: Checkout to start a
 * plan, the Customer Portal (its default configuration: plan switches with
 * prorations, cancellation at period end, invoices, payment method and tax
 * ids) and the list of invoices. Card data never reaches Kledg.
 *
 * Checkout sessions use the prices resolved by lookup key
 * (stripe-prices.ts), collect the billing address and VAT number (tax id
 * collection) and compute VAT with Stripe Tax (automatic_tax, prices
 * excluding tax). The first subscription of a client starts with the free
 * trial (CGV art. 5): 30 days, no card asked (payment_method_collection
 * if_required), and without a payment method added by the client it ends
 * instead of turning into a paid subscription. One trial per client.
 * The subscription reaches the account through the webhook
 * (stripe-webhook.service.ts), never through the success page.
 */

import type Stripe from 'stripe'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ConflictError, ExternalServiceError, ValidationError } from '@/lib/accounting/errors'
import { enforceRateLimit } from '@/lib/rate-limit'
import { getAppUrl } from '@/lib/config'
import { logger } from '@/lib/logger'
import type { CurrentUser } from '@/lib/session'
import { CLOUD_PATHS, cloudSettings } from '../config'
import { countedCompanies, ensureBillingAccount, findBillingAccount } from './billing-account.service'
import { BILLING_INTERVALS, extraCompaniesFor, PLAN_IDS } from './plans'
import { hasLiveSubscription } from './state'
import { priceOf } from './stripe-prices'
import { getStripe } from './stripe'

export const CheckoutSchema = z.object({
  plan: z.enum(PLAN_IDS, { error: 'Offre inconnue.' }),
  interval: z.enum(BILLING_INTERVALS, { error: 'Période de facturation inconnue.' }).default('month'),
})
export type CheckoutInput = z.infer<typeof CheckoutSchema>

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
      { email: user.email, name: user.name ?? undefined, preferred_locales: ['fr'], metadata: { billing_account_id: accountId } },
      { idempotencyKey: `kledg-cloud-customer-${accountId}` },
    )
    .catch((error: unknown) => stripeFailure(error, 'customer creation'))
  // Two checkouts at once get the same customer (idempotency key); only the first write lands.
  await prisma.cloudBillingAccount.updateMany({ where: { id: accountId, stripeCustomerId: null }, data: { stripeCustomerId: customer.id } })
  return (await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { id: accountId } })).stripeCustomerId ?? customer.id
}

/** A Checkout session for `plan`; answers the Stripe-hosted URL to open. */
export async function createCheckoutSession(user: CurrentUser, input: CheckoutInput, stripe: Stripe = getStripe()): Promise<{ url: string }> {
  await enforceRateLimit('cloud-billing', user.id)
  const account = await ensureBillingAccount(user.id)
  if (account.deletionScheduledFor && account.deletionReason === 'requested') {
    throw new ConflictError('La suppression de votre compte est programmée. Annulez-la depuis la page Données et compte pour vous abonner.')
  }
  if (hasLiveSubscription(account.subscriptionStatus)) {
    throw new ConflictError('Vous avez déjà un abonnement. Changez d’offre ou de moyen de paiement depuis « Gérer mon abonnement ».')
  }
  const price = await priceOf(stripe, input.plan, input.interval).catch((error: unknown) => stripeFailure(error, 'price lookup'))
  if (!price) throw new ValidationError("Cette offre n'est pas disponible pour cette période de facturation.")

  // A Cabinet account that already owns more than 25 companies (back after an ended contract) pays for them.
  const extra = extraCompaniesFor(input.plan, await countedCompanies(account.id))
  const extraPrice = extra > 0 ? await priceOf(stripe, 'cabinet_extra_company', input.interval) : null
  if (extra > 0 && !extraPrice) throw new ValidationError("Cette offre n'est pas disponible pour cette période de facturation.")

  const customer = await ensureCustomer(stripe, account.id, user)
  const base = getAppUrl()
  const trial = !account.trialUsed && !account.stripeSubscriptionId
  const session = await stripe.checkout.sessions
    .create({
      mode: 'subscription',
      customer,
      client_reference_id: account.id,
      line_items: [{ price: price.id, quantity: 1 }, ...(extraPrice ? [{ price: extraPrice.id, quantity: extra }] : [])],
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      // Required with an existing customer for tax ids and the address Stripe Tax needs.
      customer_update: { address: 'auto', name: 'auto' },
      billing_address_collection: 'required',
      allow_promotion_codes: true,
      locale: 'fr',
      // No card for the trial: Stripe asks for one only when an amount is due now.
      payment_method_collection: trial ? 'if_required' : 'always',
      subscription_data: {
        metadata: { billing_account_id: account.id },
        ...(trial
          ? {
              trial_period_days: cloudSettings().trialDays,
              // Without a payment method added by the client, the trial ends instead of billing (CGV art. 5).
              trial_settings: { end_behavior: { missing_payment_method: 'cancel' as const } },
            }
          : {}),
      },
      success_url: `${base}${CLOUD_PATHS.billing}?checkout=success`,
      cancel_url: `${base}${CLOUD_PATHS.billing}?checkout=cancel`,
    })
    .catch((error: unknown) => stripeFailure(error, 'checkout session'))
  if (!session.url) stripeFailure(new Error('Checkout session without url'), 'checkout session')
  return { url: session.url }
}

/** A Customer Portal session (its default configuration); answers the Stripe-hosted URL. */
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
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && (parsed.hostname === 'stripe.com' || parsed.hostname.endsWith('.stripe.com')) ? url : null
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

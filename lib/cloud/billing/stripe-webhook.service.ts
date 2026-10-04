/**
 * Stripe webhook of Kledg Cloud (POST /api/billing/webhook).
 *
 * 1. The signature is checked against the raw body with
 *    STRIPE_WEBHOOK_SECRET (Stripe-Signature header, 5 minute tolerance):
 *    an event that does not verify is refused before anything is read.
 * 2. The subscription is read again from Stripe, never taken from the
 *    event: events arrive late, twice or out of order, the subscription as
 *    Stripe holds it now is the truth (Stripe's own advice).
 * 3. The event id is recorded and the account updated in one transaction:
 *    an event already recorded changes nothing (idempotent), and a failure
 *    records nothing, so Stripe's retry applies it.
 *
 * Handled: checkout.session.completed, customer.subscription.created,
 * .updated and .deleted, invoice.paid and invoice.payment_failed. Other
 * events are acknowledged and ignored.
 */

import type Stripe from 'stripe'
import { Prisma, type CloudBillingAccount } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ExternalServiceError, ValidationError } from '@/lib/accounting/errors'
import { logger } from '@/lib/logger'
import { isPlanId, isProductKind, lookupKey, PRODUCT_KINDS, type PlanId, type ProductKind } from './plans'
import { getStripe, stripeWebhooks, stripeWebhookSecret } from './stripe'
import { hasLiveSubscription } from './state'
import { withSystemContext } from '@/lib/rls/context'

export const HANDLED_EVENT_TYPES = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
] as const

export type WebhookOutcome =
  | { status: 'applied'; billingAccountId: string }
  | { status: 'duplicate' }
  | { status: 'ignored'; reason: 'unhandled_type' | 'unknown_customer' | 'not_a_subscription' | 'stale_subscription' }

const ENDED = new Set(['canceled', 'incomplete_expired'])
const PAYMENT_ISSUE = new Set(['past_due', 'unpaid'])

const idOf = (value: string | { id: string } | null | undefined): string | null =>
  typeof value === 'string' ? value : (value?.id ?? null)

const fromUnix = (seconds: number | null | undefined): Date | null => (seconds ? new Date(seconds * 1000) : null)

/**
 * What a subscription item is: the `kledg_plan` metadata of its product
 * (stable across price changes), else the lookup key of its price.
 */
export function itemKind(item: Stripe.SubscriptionItem): ProductKind | null {
  const product = item.price.product
  if (product && typeof product === 'object' && !('deleted' in product && product.deleted)) {
    const kind = (product as Stripe.Product).metadata?.kledg_plan
    if (isProductKind(kind)) return kind
  }
  const key = item.price.lookup_key
  return PRODUCT_KINDS.find((kind) => key === lookupKey(kind, 'month') || key === lookupKey(kind, 'year')) ?? null
}

/**
 * The discount of a subscription (a promotion code entered at Checkout), as
 * a French summary for the operator ("-80 %, à vie"): never the code
 * itself. Stripe applies it before tax and shows it on the invoices; plan
 * limits do not depend on it.
 */
export function discountFields(subscription: Stripe.Subscription): { discountSummary: string | null; discountEnd: Date | null } {
  const discount = subscription.discounts.find((d): d is Stripe.Discount => typeof d === 'object' && d !== null)
  const coupon = discount?.source?.coupon
  if (!discount || !coupon || typeof coupon === 'string') {
    return { discountSummary: subscription.discounts.length > 0 ? 'Remise' : null, discountEnd: null }
  }
  const amount =
    coupon.percent_off !== null
      ? `-${String(coupon.percent_off).replace('.', ',')} %`
      : coupon.amount_off !== null
        ? `-${(coupon.amount_off / 100).toFixed(2).replace('.', ',')} €`
        : 'Remise'
  const duration =
    coupon.duration === 'forever'
      ? 'à vie'
      : coupon.duration === 'once'
        ? 'sur la première facture'
        : `pendant ${coupon.duration_in_months ?? '?'} mois`
  return { discountSummary: `${amount}, ${duration}`, discountEnd: fromUnix(discount.end) }
}

/** The billing fields mirrored from a subscription as Stripe holds it (items expanded with their product). */
export function subscriptionFields(subscription: Stripe.Subscription) {
  const items = subscription.items.data
  const base = items.find((item) => isPlanId(itemKind(item)))
  const extra = items.find((item) => itemKind(item) === 'cabinet_extra_company')
  const interval = base?.price.recurring?.interval
  return {
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: subscription.status,
    planId: base ? (itemKind(base) as PlanId) : null,
    priceId: base?.price.id ?? null,
    billingInterval: interval === 'month' || interval === 'year' ? interval : null,
    trialEnd: fromUnix(subscription.trial_end),
    // Since API 2025-03-31 the billing period is carried by the items.
    currentPeriodEnd: fromUnix((base ?? items[0])?.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end || subscription.cancel_at !== null,
    subscriptionEndedAt: fromUnix(subscription.ended_at),
    extraCompanies: extra?.quantity ?? 0,
    dedicatedDatabase: items.some((item) => itemKind(item) === 'dedicated_database'),
    ...discountFields(subscription),
  }
}

/** Verifies the signature and parses the event; 400 in French otherwise. */
export function verifyStripeEvent(rawBody: string, signature: string | null, now: Date = new Date()): Stripe.Event {
  const secret = stripeWebhookSecret()
  if (!secret) {
    logger.error('Stripe webhook received but STRIPE_WEBHOOK_SECRET is not set')
    throw new ExternalServiceError('Webhook non configuré.')
  }
  if (!signature) throw new ValidationError('Signature Stripe manquante.')
  try {
    // Five minutes of tolerance against replays of an old signed delivery (receivedAt in milliseconds).
    return stripeWebhooks.constructEvent(rawBody, signature, secret, 300, undefined, now.getTime())
  } catch {
    throw new ValidationError('Signature Stripe invalide.')
  }
}

interface Target {
  account: CloudBillingAccount
  subscription: Stripe.Subscription
}

async function accountByCustomer(customerId: string | null, metadataAccountId?: string | null): Promise<CloudBillingAccount | null> {
  if (customerId) {
    const byCustomer = await prisma.cloudBillingAccount.findUnique({ where: { stripeCustomerId: customerId } })
    if (byCustomer) return byCustomer
  }
  // A subscription created by our checkout carries its account id; only an account without a customer yet may adopt one.
  if (metadataAccountId) {
    const byId = await prisma.cloudBillingAccount.findUnique({ where: { id: metadataAccountId } })
    if (byId && (!byId.stripeCustomerId || byId.stripeCustomerId === customerId)) return byId
  }
  return null
}

/** The account and the current subscription the event is about, or why it is ignored. */
async function resolveTarget(event: Stripe.Event, stripe: Stripe): Promise<Target | Extract<WebhookOutcome, { status: 'ignored' }>> {
  let subscriptionId: string | null = null
  let account: CloudBillingAccount | null = null

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object
      if (session.mode !== 'subscription') return { status: 'ignored', reason: 'not_a_subscription' }
      subscriptionId = idOf(session.subscription)
      account = await accountByCustomer(idOf(session.customer), session.client_reference_id)
      break
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object
      subscriptionId = subscription.id
      account = await accountByCustomer(idOf(subscription.customer), subscription.metadata?.billing_account_id)
      break
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const invoice = event.data.object
      subscriptionId = idOf(invoice.parent?.subscription_details?.subscription)
      if (!subscriptionId) return { status: 'ignored', reason: 'not_a_subscription' }
      account = await accountByCustomer(idOf(invoice.customer))
      break
    }
    default:
      return { status: 'ignored', reason: 'unhandled_type' }
  }

  if (!subscriptionId) return { status: 'ignored', reason: 'not_a_subscription' }
  if (!account) {
    logger.warn('Stripe event for a customer without a billing account', { eventId: event.id, type: event.type })
    return { status: 'ignored', reason: 'unknown_customer' }
  }
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price.product', 'discounts.source.coupon'] })
  // An old subscription ending must not replace the one the account pays now.
  if (account.stripeSubscriptionId && account.stripeSubscriptionId !== subscription.id && ENDED.has(subscription.status)) {
    return { status: 'ignored', reason: 'stale_subscription' }
  }
  return { account, subscription }
}

/** Applies a verified event, once. */
export async function applyStripeEvent(event: Stripe.Event, stripe: Stripe = getStripe(), now: Date = new Date()): Promise<WebhookOutcome> {
  if (await prisma.cloudStripeEvent.findUnique({ where: { id: event.id }, select: { id: true } })) return { status: 'duplicate' }

  const target = await resolveTarget(event, stripe)

  return prisma.$transaction(async (tx) => {
    // The primary key serializes concurrent deliveries of the same event: the second one waits, then finds it.
    const inserted = await tx.cloudStripeEvent.createMany({ data: [{ id: event.id, type: event.type }], skipDuplicates: true })
    if (inserted.count === 0) return { status: 'duplicate' } as const
    if (!('account' in target)) return target

    const { account, subscription } = target
    const fields = subscriptionFields(subscription)
    const customerId = idOf(subscription.customer)
    const paymentIssue = PAYMENT_ISSUE.has(subscription.status)
    const eventAt = fromUnix(event.created) ?? now
    // A client who subscribes again during the retrieval period keeps everything.
    const comeback = hasLiveSubscription(subscription.status) && account.deletionReason === 'contract_ended'
    await tx.cloudBillingAccount.update({
      where: { id: account.id },
      data: {
        ...fields,
        ...(customerId && !account.stripeCustomerId ? { stripeCustomerId: customerId } : {}),
        // One free trial per client (CGV art. 5).
        ...(subscription.trial_start ? { trialUsed: true } : {}),
        ...(comeback ? { deletionScheduledFor: null, deletionReason: null, contractEndNoticeFor: null } : {}),
        // The first failure of an incident starts the grace period; a paid subscription clears it.
        paymentFailedAt: paymentIssue ? (account.paymentFailedAt ?? (event.type === 'invoice.payment_failed' ? eventAt : now)) : null,
        stripeSyncedAt: now,
      },
    })
    return { status: 'applied', billingAccountId: account.id } as const
  })
}

/** Verifies, then applies (the route's whole job). */
export async function receiveStripeWebhook(rawBody: string, signature: string | null, stripe?: Stripe): Promise<WebhookOutcome> {
  const event = verifyStripeEvent(rawBody, signature)
  try {
    // No user: Stripe calls. A system context reaches the billing accounts (docs/rls.md); the
    // signature checked above is what authorizes it.
    return await withSystemContext('instance-extension', () => applyStripeEvent(event, stripe))
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // Another account already holds this customer or subscription: never move it silently.
      logger.error('Stripe event conflicts with another billing account', { eventId: event.id, type: event.type })
      throw new ExternalServiceError('Événement Stripe en conflit avec un autre compte.')
    }
    logger.error('Stripe event could not be applied, Stripe will retry', { eventId: event.id, type: event.type, error })
    throw new ExternalServiceError("L'événement Stripe n'a pas pu être appliqué.")
  }
}

/** Events older than 90 days are past Stripe's retry window (3 days): their ids can go. */
export async function purgeProcessedStripeEvents(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.cloudStripeEvent.deleteMany({ where: { processedAt: { lt: new Date(now.getTime() - 90 * 86_400_000) } } })
  return count
}

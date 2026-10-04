/**
 * Stripe test doubles for Kledg Cloud tests: objects shaped exactly like
 * Stripe's (API 2026-09-30.endive), signed webhook payloads, and a fetch
 * that plays Stripe's API so the real SDK runs without any request leaving
 * the machine. No real key or price id anywhere.
 */

import Stripe from 'stripe'
import { createStripe, STRIPE_API_VERSION } from '@/lib/cloud/billing/stripe'

/** A fake webhook secret with Stripe's prefix (never a real one). */
export const TEST_WEBHOOK_SECRET = 'whsec_' + 'kledgcloudtestsecret'.repeat(2)
/** A fake secret key with Stripe's test prefix, built at run time (never a real key). */
export const TEST_SECRET_KEY = ['sk', 'test', 'kledgcloud'.repeat(3)].join('_')

export const PRICES = {
  essentielMonthly: 'price_TestEssentielMonth01',
  holdingMonthly: 'price_TestHoldingMonth0001',
  holdingYearly: 'price_TestHoldingYear00001',
  cabinetMonthly: 'price_TestCabinetMonth0001',
}

export const PRICE_ENV = {
  STRIPE_PRICE_ESSENTIEL_MONTHLY: PRICES.essentielMonthly,
  STRIPE_PRICE_HOLDING_MONTHLY: PRICES.holdingMonthly,
  STRIPE_PRICE_HOLDING_YEARLY: PRICES.holdingYearly,
  STRIPE_PRICE_CABINET_MONTHLY: PRICES.cabinetMonthly,
}

const unix = (date: Date) => Math.floor(date.getTime() / 1000)

export function subscriptionObject(over: {
  id: string
  customer: string
  status: Stripe.Subscription.Status
  price?: string
  periodEnd?: Date
  cancelAtPeriodEnd?: boolean
  endedAt?: Date | null
  metadata?: Record<string, string>
}) {
  const periodEnd = over.periodEnd ?? new Date('2026-11-20T00:00:00Z')
  const periodStart = new Date(periodEnd.getTime() - 30 * 86_400_000)
  const price = over.price ?? PRICES.holdingMonthly
  return {
    id: over.id,
    object: 'subscription',
    application: null,
    automatic_tax: { disabled_reason: null, enabled: true, liability: { type: 'self' } },
    billing_cycle_anchor: unix(periodStart),
    cancel_at: over.cancelAtPeriodEnd ? unix(periodEnd) : null,
    cancel_at_period_end: over.cancelAtPeriodEnd ?? false,
    canceled_at: over.endedAt ? unix(over.endedAt) : null,
    collection_method: 'charge_automatically',
    created: unix(periodStart),
    currency: 'eur',
    customer: over.customer,
    default_payment_method: 'pm_TestCard000001',
    ended_at: over.endedAt ? unix(over.endedAt) : null,
    items: {
      object: 'list',
      data: [
        {
          id: `si_${over.id.slice(4)}`,
          object: 'subscription_item',
          created: unix(periodStart),
          current_period_end: unix(periodEnd),
          current_period_start: unix(periodStart),
          metadata: {},
          price: {
            id: price,
            object: 'price',
            active: true,
            currency: 'eur',
            lookup_key: null,
            product: 'prod_TestKledgCloud01',
            recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
            tax_behavior: 'exclusive',
            type: 'recurring',
            unit_amount: 2900,
          },
          quantity: 1,
          subscription: over.id,
        },
      ],
      has_more: false,
      url: `/v1/subscription_items?subscription=${over.id}`,
    },
    latest_invoice: 'in_TestLatest00001',
    livemode: false,
    metadata: over.metadata ?? {},
    status: over.status,
    trial_end: null,
    trial_start: null,
  }
}

export function checkoutSessionObject(over: { id: string; customer: string; subscription: string; clientReferenceId: string; mode?: string }) {
  return {
    id: over.id,
    object: 'checkout.session',
    automatic_tax: { enabled: true, liability: { type: 'self' }, status: 'complete' },
    client_reference_id: over.clientReferenceId,
    created: unix(new Date('2026-10-20T10:00:00Z')),
    currency: 'eur',
    customer: over.customer,
    customer_details: { email: 'owner@test.local', tax_exempt: 'none', tax_ids: [{ type: 'eu_vat', value: 'FR40303265045' }] },
    livemode: false,
    mode: over.mode ?? 'subscription',
    payment_status: 'paid',
    status: 'complete',
    subscription: over.subscription,
    tax_id_collection: { enabled: true, required: 'never' },
  }
}

export function invoiceObject(over: { id: string; customer: string; subscription: string | null; status?: string }) {
  return {
    id: over.id,
    object: 'invoice',
    created: unix(new Date('2026-10-20T10:00:00Z')),
    currency: 'eur',
    customer: over.customer,
    hosted_invoice_url: `https://invoice.stripe.com/i/acct_Test/${over.id}`,
    invoice_pdf: `https://pay.stripe.com/invoice/acct_Test/${over.id}/pdf`,
    livemode: false,
    number: 'KLEDG-0001',
    parent: over.subscription
      ? { quote_details: null, subscription_details: { metadata: {}, subscription: over.subscription }, type: 'subscription_details' }
      : null,
    status: over.status ?? 'paid',
    total: 3480,
  }
}

let eventSequence = 0

/** A Stripe event around `object`, as the webhook receives it. */
export function stripeEvent(type: string, object: unknown, created: Date = new Date('2026-10-20T10:00:00Z'), id?: string) {
  eventSequence += 1
  return {
    id: id ?? `evt_TestKledg${String(eventSequence).padStart(8, '0')}`,
    object: 'event',
    api_version: STRIPE_API_VERSION,
    created: unix(created),
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
  }
}

/** The Stripe-Signature header Stripe would send for `payload` (now, or at `timestamp` in seconds). */
export function signatureFor(payload: string, secret = TEST_WEBHOOK_SECRET, timestamp?: number): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret, ...(timestamp ? { timestamp } : {}) })
}

export interface StripeCall {
  method: string
  path: string
  body: string
  idempotencyKey: string | null
}

/**
 * A fetch playing Stripe's API: `routes` maps "METHOD /v1/path" to a JSON
 * answer (or a function of the request). Unknown routes answer Stripe's 404.
 */
export function stripeFetch(routes: Record<string, unknown | ((call: StripeCall) => { status?: number; body: unknown })>) {
  const calls: StripeCall[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname !== 'api.stripe.com') throw new Error(`Unexpected host ${url.hostname}`)
    const headers = new Headers(init?.headers)
    const call: StripeCall = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: typeof init?.body === 'string' ? init.body : url.search.slice(1),
      idempotencyKey: headers.get('idempotency-key'),
    }
    calls.push(call)
    const route = routes[`${call.method} ${call.path}`]
    const answer =
      typeof route === 'function'
        ? (route as (c: StripeCall) => { status?: number; body: unknown })(call)
        : route === undefined
          ? { status: 404, body: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such resource' } } }
          : { body: route }
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json', 'request-id': 'req_Test' } })
  }) as typeof fetch
  return { fetchFn, calls, stripe: createStripe(TEST_SECRET_KEY, fetchFn) }
}

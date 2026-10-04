/**
 * Stripe test doubles for Kledg Cloud tests: objects shaped exactly like
 * Stripe's (API 2026-09-30.endive): products with their `kledg_plan`
 * metadata, prices with their lookup keys, subscriptions with expanded
 * items, signed webhook payloads, and a fetch that plays Stripe's API so the
 * real SDK runs without any request leaving the machine. No real key, price
 * or product id anywhere.
 */

import Stripe from 'stripe'
import { createStripe, STRIPE_API_VERSION } from '@/lib/cloud/billing/stripe'
import { lookupKey, type BillingInterval, type ProductKind } from '@/lib/cloud/billing/plans'

/** A fake webhook secret with Stripe's prefix (never a real one). */
export const TEST_WEBHOOK_SECRET = 'whsec_' + 'kledgcloudtestsecret'.repeat(2)
/** A fake secret key with Stripe's test prefix, built at run time (never a real key). */
export const TEST_SECRET_KEY = ['sk', 'test', 'kledgcloud'.repeat(3)].join('_')

/** The amounts of the offer (cents, excluding tax). */
export const AMOUNTS: Record<ProductKind, Record<BillingInterval, number>> = {
  essentiel: { month: 1500, year: 15000 },
  holding: { month: 3900, year: 39000 },
  cabinet: { month: 9900, year: 99000 },
  cabinet_extra_company: { month: 300, year: 3000 },
  dedicated_database: { month: 2000, year: 20000 },
}

const pascal = (kind: string) => kind.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase())

/** Test price id of a lookup key (price_TestHoldingYear...). */
export function priceId(kind: ProductKind, interval: BillingInterval): string {
  return `price_Test${pascal(kind)}${interval === 'month' ? 'Month' : 'Year'}`
}

export function productObject(kind: ProductKind) {
  return { id: `prod_Test${pascal(kind)}`, object: 'product', active: true, name: `Kledg ${kind}`, metadata: { kledg_plan: kind }, tax_code: 'txcd_10103001' }
}

/** A price as Stripe returns it; `product` expanded or as an id. */
export function priceObject(kind: ProductKind, interval: BillingInterval, options: { expandProduct?: boolean; lookup?: string | null } = {}) {
  return {
    id: priceId(kind, interval),
    object: 'price',
    active: true,
    billing_scheme: 'per_unit',
    currency: 'eur',
    livemode: false,
    lookup_key: options.lookup === undefined ? lookupKey(kind, interval) : options.lookup,
    metadata: {},
    product: options.expandProduct === false ? productObject(kind).id : productObject(kind),
    recurring: { interval, interval_count: 1, usage_type: 'licensed' },
    tax_behavior: 'exclusive',
    type: 'recurring',
    unit_amount: AMOUNTS[kind][interval],
  }
}

/** GET /v1/prices?lookup_keys[]=...: every price of the offer (products as ids, like a list without expand). */
export function pricesList(kinds: ProductKind[] = ['essentiel', 'holding', 'cabinet', 'cabinet_extra_company', 'dedicated_database']) {
  return {
    object: 'list',
    has_more: false,
    url: '/v1/prices',
    data: kinds.flatMap((kind) => (['month', 'year'] as const).map((interval) => priceObject(kind, interval, { expandProduct: false }))),
  }
}

const unix = (date: Date) => Math.floor(date.getTime() / 1000)

export function subscriptionObject(over: {
  id: string
  customer: string
  status: Stripe.Subscription.Status
  plan?: ProductKind
  interval?: BillingInterval
  extraCompanies?: number
  dedicatedDatabase?: boolean
  periodEnd?: Date
  cancelAtPeriodEnd?: boolean
  endedAt?: Date | null
  trial?: { start: Date; end: Date }
  /** A price that lost its lookup key (an early adopter after a price change): only the product says what it is. */
  legacyPrice?: boolean
  metadata?: Record<string, string>
}) {
  const interval = over.interval ?? 'month'
  const periodEnd = over.periodEnd ?? new Date('2026-11-20T00:00:00Z')
  const periodStart = new Date(periodEnd.getTime() - (interval === 'month' ? 30 : 365) * 86_400_000)
  const item = (kind: ProductKind, quantity: number, suffix: string) => ({
    id: `si_${over.id.slice(4)}${suffix}`,
    object: 'subscription_item',
    created: unix(periodStart),
    current_period_end: unix(periodEnd),
    current_period_start: unix(periodStart),
    metadata: {},
    price: { ...priceObject(kind, interval, { lookup: over.legacyPrice ? null : undefined }), ...(over.legacyPrice ? { id: `price_TestLegacy${pascal(kind)}` } : {}) },
    quantity,
    subscription: over.id,
  })
  const items = [
    item(over.plan ?? 'holding', 1, ''),
    ...(over.extraCompanies ? [item('cabinet_extra_company', over.extraCompanies, 'X')] : []),
    ...(over.dedicatedDatabase ? [item('dedicated_database', 1, 'D')] : []),
  ]
  return {
    id: over.id,
    object: 'subscription',
    automatic_tax: { disabled_reason: null, enabled: true, liability: { type: 'self' } },
    billing_cycle_anchor: unix(periodStart),
    cancel_at: over.cancelAtPeriodEnd ? unix(periodEnd) : null,
    cancel_at_period_end: over.cancelAtPeriodEnd ?? false,
    canceled_at: over.endedAt ? unix(over.endedAt) : null,
    collection_method: 'charge_automatically',
    created: unix(periodStart),
    currency: 'eur',
    customer: over.customer,
    default_payment_method: over.trial ? null : 'pm_TestCard000001',
    ended_at: over.endedAt ? unix(over.endedAt) : null,
    items: { object: 'list', data: items, has_more: false, url: `/v1/subscription_items?subscription=${over.id}` },
    latest_invoice: 'in_TestLatest00001',
    livemode: false,
    metadata: over.metadata ?? {},
    status: over.status,
    trial_end: over.trial ? unix(over.trial.end) : null,
    trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
    trial_start: over.trial ? unix(over.trial.start) : null,
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
    payment_status: 'no_payment_required',
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
    total: 4680,
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
  /** Form body (POST) or query string (GET). */
  body: string
  idempotencyKey: string | null
}

type Answer = { status?: number; body: unknown }

/**
 * A fetch playing Stripe's API: `routes` maps "METHOD /v1/path" to a JSON
 * answer (or a function of the call). Unknown routes answer Stripe's 404.
 */
export function stripeFetch(routes: Record<string, unknown>) {
  const calls: StripeCall[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname !== 'api.stripe.com') throw new Error(`Unexpected host ${url.hostname}`)
    const headers = new Headers(init?.headers)
    const call: StripeCall = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: typeof init?.body === 'string' ? init.body : decodeURIComponent(url.search.slice(1)),
      idempotencyKey: headers.get('idempotency-key'),
    }
    calls.push(call)
    const route = routes[`${call.method} ${call.path}`]
    const answer: Answer =
      typeof route === 'function'
        ? (route as (c: StripeCall) => Answer)(call)
        : route === undefined
          ? { status: 404, body: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such resource' } } }
          : { body: route }
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json', 'request-id': 'req_Test' } })
  }) as typeof fetch
  return { fetchFn, calls, stripe: createStripe(TEST_SECRET_KEY, fetchFn) }
}

/** Form fields of a Stripe call (`a[b][0]=c` keys kept flat). */
export const form = (body: string) => Object.fromEntries(new URLSearchParams(body))

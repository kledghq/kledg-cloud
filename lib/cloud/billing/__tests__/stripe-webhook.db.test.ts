/**
 * Stripe webhook (POST /api/billing/webhook) against PostgreSQL, through the
 * real route and the real Stripe SDK on a mocked fetch:
 * - signature: missing, wrong secret, tampered body or too old: 400, and
 *   nothing is recorded;
 * - each handled event mirrors the subscription as Stripe holds it now
 *   (read again from the API), whatever order the events come in;
 * - idempotency: a replayed event changes nothing and calls nothing, two
 *   concurrent deliveries apply once, a failed application records nothing
 *   so Stripe's retry applies it;
 * - foreign customers, unhandled types and stale subscriptions are ignored.
 *
 * Skipped when the test database server is unreachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const stripeState = await vi.hoisted(async () => {
  const { useTestDatabase } = await import('@/lib/__tests__/helpers/test-db')
  useTestDatabase('cloud_webhook')
  process.env.KLEDG_CLOUD_MODE = 'true'
  return { stripe: null as unknown }
})

vi.mock('@/lib/cloud/billing/stripe', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/cloud/billing/stripe')>()
  return { ...real, getStripe: () => stripeState.stripe }
})

import { prepareTestDatabase, testDatabaseAvailable } from '@/lib/__tests__/helpers/test-db'
import {
  checkoutSessionObject,
  invoiceObject,
  signatureFor,
  stripeEvent,
  stripeFetch,
  subscriptionObject,
  TEST_WEBHOOK_SECRET,
} from '../../__tests__/helpers/stripe-fixtures'

const available = await testDatabaseAvailable()

let prisma: typeof import('@/lib/prisma').prisma
let POST: (request: Request) => Promise<Response>

/** Subscriptions as Stripe holds them now, by id: what the API answers. */
const live: Record<string, ReturnType<typeof subscriptionObject>> = {}
let api: ReturnType<typeof stripeFetch>

function deliver(event: unknown, options: { signature?: string | null; body?: string } = {}) {
  const body = options.body ?? JSON.stringify(event)
  const signature = options.signature === undefined ? signatureFor(JSON.stringify(event)) : options.signature
  return POST(
    new NextRequest('http://localhost/api/billing/webhook', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) },
    }),
  )
}

const account = (id = 'ba-owner') => prisma.cloudBillingAccount.findUniqueOrThrow({ where: { id } })

describe.skipIf(!available)('Stripe webhook', () => {
  beforeAll(async () => {
    await prepareTestDatabase('cloud_webhook')
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ POST } = (await import('@/app/api/billing/webhook/route')) as unknown as { POST: typeof POST })
  }, 120_000)

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  beforeEach(async () => {
    vi.stubEnv('KLEDG_CLOUD_MODE', 'true')
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', TEST_WEBHOOK_SECRET)
    await prisma.cloudStripeEvent.deleteMany()
    await prisma.cloudBillingAccount.deleteMany()
    await prisma.cloudBillingAccount.create({
      data: { id: 'ba-owner', ownerUserId: 'u-owner' },
    })
    for (const key of Object.keys(live)) delete live[key]
    api = stripeFetch({
      'GET /v1/subscriptions/sub_TestKledg0001': () => (live.sub_TestKledg0001 ? { body: live.sub_TestKledg0001 } : { status: 404, body: {} }),
      'GET /v1/subscriptions/sub_TestKledg0002': () => (live.sub_TestKledg0002 ? { body: live.sub_TestKledg0002 } : { status: 404, body: {} }),
    })
    stripeState.stripe = api.stripe
  })

  describe('signature', () => {
    const event = () => stripeEvent('customer.subscription.updated', subscriptionObject({ id: 'sub_TestKledg0001', customer: 'cus_TestOwner0001', status: 'active' }))

    it('refuses an event without a signature, signed with another secret, tampered or too old, and records nothing', async () => {
      const e = event()
      const payload = JSON.stringify(e)
      const cases = [
        await deliver(e, { signature: null }),
        await deliver(e, { signature: signatureFor(payload, 'whsec_' + 'anothersecretanother'.repeat(2)) }),
        await deliver(e, { body: payload.replace('"active"', '"canceled"') }),
        await deliver(e, { signature: signatureFor(payload, TEST_WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600) }),
      ]
      expect(cases.map((r) => r.status)).toEqual([400, 400, 400, 400])
      expect(await cases[0].json()).toEqual({ error: 'Signature Stripe manquante.' })
      expect(await cases[1].json()).toEqual({ error: 'Signature Stripe invalide.' })
      expect(await prisma.cloudStripeEvent.count()).toBe(0)
      expect(api.calls).toEqual([])
    })

    it('answers 502 without a configured secret, so Stripe retries once it is set', async () => {
      vi.stubEnv('STRIPE_WEBHOOK_SECRET', '')
      expect((await deliver(event())).status).toBe(502)
    })

    it('is a 404 outside cloud mode', async () => {
      vi.stubEnv('KLEDG_CLOUD_MODE', '')
      expect((await deliver(event())).status).toBe(404)
    })
  })

  it('checkout.session.completed links the customer and mirrors the subscription read from Stripe', async () => {
    live.sub_TestKledg0001 = subscriptionObject({ id: 'sub_TestKledg0001', customer: 'cus_TestOwner0001', status: 'active', periodEnd: new Date('2026-11-20T00:00:00Z') })
    const event = stripeEvent(
      'checkout.session.completed',
      checkoutSessionObject({ id: 'cs_TestKledg0001', customer: 'cus_TestOwner0001', subscription: 'sub_TestKledg0001', clientReferenceId: 'ba-owner' }),
    )
    const response = await deliver(event)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: true, status: 'applied' })
    expect(await account()).toMatchObject({
      stripeCustomerId: 'cus_TestOwner0001',
      stripeSubscriptionId: 'sub_TestKledg0001',
      subscriptionStatus: 'active',
      planId: 'holding',
      priceId: 'price_TestHoldingMonth',
      billingInterval: 'month',
      trialUsed: false,
      extraCompanies: 0,
      dedicatedDatabase: false,
      currentPeriodEnd: new Date('2026-11-20T00:00:00Z'),
      cancelAtPeriodEnd: false,
      paymentFailedAt: null,
    })
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/subscriptions/sub_TestKledg0001'])
    // Products come expanded: their kledg_plan metadata says what each line is.
    expect(api.calls[0].body).toContain('expand[0]=items.data.price.product')
    expect(await prisma.cloudStripeEvent.findUnique({ where: { id: event.id } })).toMatchObject({ type: 'checkout.session.completed' })
  })

  it('applies a replayed event once: the second delivery changes nothing and calls nothing', async () => {
    live.sub_TestKledg0001 = subscriptionObject({ id: 'sub_TestKledg0001', customer: 'cus_TestOwner0001', status: 'active' })
    const event = stripeEvent(
      'checkout.session.completed',
      checkoutSessionObject({ id: 'cs_TestKledg0002', customer: 'cus_TestOwner0001', subscription: 'sub_TestKledg0001', clientReferenceId: 'ba-owner' }),
    )
    expect(await (await deliver(event)).json()).toMatchObject({ status: 'applied' })
    const after = await account()
    live.sub_TestKledg0001 = subscriptionObject({ id: 'sub_TestKledg0001', customer: 'cus_TestOwner0001', status: 'canceled', endedAt: new Date() })
    const replay = await deliver(event)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ received: true, status: 'duplicate' })
    expect((await account()).subscriptionStatus).toBe(after.subscriptionStatus)
    expect(api.calls).toHaveLength(1)
  })

  it('applies two concurrent deliveries of the same event once', async () => {
    live.sub_TestKledg0001 = subscriptionObject({ id: 'sub_TestKledg0001', customer: 'cus_TestOwner0001', status: 'active' })
    const event = stripeEvent(
      'checkout.session.completed',
      checkoutSessionObject({ id: 'cs_TestKledg0003', customer: 'cus_TestOwner0001', subscription: 'sub_TestKledg0001', clientReferenceId: 'ba-owner' }),
    )
    const outcomes = await Promise.all([deliver(event), deliver(event)].map(async (p) => ((await (await p).json()) as { status: string }).status))
    expect(outcomes.sort()).toEqual(['applied', 'duplicate'])
    expect(await prisma.cloudStripeEvent.count()).toBe(1)
  })

  it('starts the grace period at the first failed payment, keeps it on retries, clears it once paid', async () => {
    await prisma.cloudBillingAccount.update({ where: { id: 'ba-owner' }, data: { stripeCustomerId: 'cus_TestOwner0001' } })
    live.sub_TestKledg0001 = subscriptionObject({ id: 'sub_TestKledg0001', customer: 'cus_TestOwner0001', status: 'past_due' })
    const firstFailure = new Date('2026-12-20T08:00:00Z')
    const invoice = invoiceObject({ id: 'in_TestKledg0001', customer: 'cus_TestOwner0001', subscription: 'sub_TestKledg0001', status: 'open' })
    expect((await deliver(stripeEvent('invoice.payment_failed', invoice, firstFailure))).status).toBe(200)
    expect(await account()).toMatchObject({ subscriptionStatus: 'past_due', paymentFailedAt: firstFailure })

    await deliver(stripeEvent('invoice.payment_failed', invoice, new Date('2026-12-23T08:00:00Z')))
    expect((await account()).paymentFailedAt).toEqual(firstFailure)

    live.sub_TestKledg0001 = subscriptionObject({ id: 'sub_TestKledg0001', customer: 'cus_TestOwner0001', status: 'active' })
    await deliver(stripeEvent('invoice.paid', { ...invoice, status: 'paid' }, new Date('2026-12-24T08:00:00Z')))
    expect(await account()).toMatchObject({ subscriptionStatus: 'active', paymentFailedAt: null })
  })

  it('follows Stripe, not the event: an old update delivered after the deletion keeps the subscription ended', async () => {
    await prisma.cloudBillingAccount.update({ where: { id: 'ba-owner' }, data: { stripeCustomerId: 'cus_TestOwner0001', stripeSubscriptionId: 'sub_TestKledg0001' } })
    const endedAt = new Date('2027-01-31T00:00:00Z')
    live.sub_TestKledg0001 = subscriptionObject({ id: 'sub_TestKledg0001', customer: 'cus_TestOwner0001', status: 'canceled', endedAt })
    const deleted = stripeEvent('customer.subscription.deleted', live.sub_TestKledg0001, endedAt)
    const oldUpdate = stripeEvent(
      'customer.subscription.updated',
      subscriptionObject({ id: 'sub_TestKledg0001', customer: 'cus_TestOwner0001', status: 'active' }),
      new Date('2027-01-10T00:00:00Z'),
    )
    await deliver(deleted)
    await deliver(oldUpdate)
    expect(await account()).toMatchObject({ subscriptionStatus: 'canceled', subscriptionEndedAt: endedAt })
  })

  it('records a cancellation at period end', async () => {
    await prisma.cloudBillingAccount.update({ where: { id: 'ba-owner' }, data: { stripeCustomerId: 'cus_TestOwner0001' } })
    live.sub_TestKledg0001 = subscriptionObject({
      id: 'sub_TestKledg0001',
      customer: 'cus_TestOwner0001',
      status: 'active',
      plan: 'essentiel',
      cancelAtPeriodEnd: true,
      periodEnd: new Date('2027-02-20T00:00:00Z'),
    })
    await deliver(stripeEvent('customer.subscription.updated', live.sub_TestKledg0001))
    expect(await account()).toMatchObject({ planId: 'essentiel', cancelAtPeriodEnd: true, currentPeriodEnd: new Date('2027-02-20T00:00:00Z') })
  })

  it('records the free trial (one per client) and its end', async () => {
    await prisma.cloudBillingAccount.update({ where: { id: 'ba-owner' }, data: { stripeCustomerId: 'cus_TestOwner0001' } })
    const trial = { start: new Date('2026-10-20T10:00:00Z'), end: new Date('2026-11-19T10:00:00Z') }
    live.sub_TestKledg0001 = subscriptionObject({ id: 'sub_TestKledg0001', customer: 'cus_TestOwner0001', status: 'trialing', plan: 'cabinet', trial })
    await deliver(stripeEvent('customer.subscription.created', live.sub_TestKledg0001))
    expect(await account()).toMatchObject({ subscriptionStatus: 'trialing', planId: 'cabinet', trialUsed: true, trialEnd: trial.end })
    // The trial ends without a card: Stripe cancels the subscription; the trial stays used.
    live.sub_TestKledg0001 = subscriptionObject({ id: 'sub_TestKledg0001', customer: 'cus_TestOwner0001', status: 'canceled', plan: 'cabinet', endedAt: trial.end })
    await deliver(stripeEvent('customer.subscription.deleted', live.sub_TestKledg0001, trial.end))
    expect(await account()).toMatchObject({ subscriptionStatus: 'canceled', trialUsed: true, subscriptionEndedAt: trial.end })
  })

  it('reads the plan from the product metadata, extra companies and the dedicated database from their lines, yearly prices included', async () => {
    await prisma.cloudBillingAccount.update({ where: { id: 'ba-owner' }, data: { stripeCustomerId: 'cus_TestOwner0001' } })
    live.sub_TestKledg0001 = subscriptionObject({
      id: 'sub_TestKledg0001',
      customer: 'cus_TestOwner0001',
      status: 'active',
      plan: 'cabinet',
      interval: 'year',
      extraCompanies: 7,
      dedicatedDatabase: true,
      // An early adopter's price lost its lookup key when the price changed: the product still says Cabinet.
      legacyPrice: true,
    })
    await deliver(stripeEvent('customer.subscription.updated', live.sub_TestKledg0001))
    expect(await account()).toMatchObject({
      planId: 'cabinet',
      priceId: 'price_TestLegacyCabinet',
      billingInterval: 'year',
      extraCompanies: 7,
      dedicatedDatabase: true,
    })
  })

  it('keeps an account whose owner subscribes again during the retrieval period', async () => {
    await prisma.cloudBillingAccount.update({
      where: { id: 'ba-owner' },
      data: {
        stripeCustomerId: 'cus_TestOwner0001',
        subscriptionStatus: 'canceled',
        deletionScheduledFor: new Date('2026-12-01T00:00:00Z'),
        deletionReason: 'contract_ended',
        contractEndNoticeFor: new Date('2026-11-01T00:00:00Z'),
      },
    })
    live.sub_TestKledg0002 = subscriptionObject({ id: 'sub_TestKledg0002', customer: 'cus_TestOwner0001', status: 'active' })
    await deliver(stripeEvent('customer.subscription.created', live.sub_TestKledg0002))
    expect(await account()).toMatchObject({ subscriptionStatus: 'active', deletionScheduledFor: null, deletionReason: null, contractEndNoticeFor: null })
  })

  it('ignores a stale subscription ending while the account pays another one', async () => {
    await prisma.cloudBillingAccount.update({
      where: { id: 'ba-owner' },
      data: { stripeCustomerId: 'cus_TestOwner0001', stripeSubscriptionId: 'sub_TestKledg0002', subscriptionStatus: 'active', planId: 'cabinet' },
    })
    live.sub_TestKledg0001 = subscriptionObject({ id: 'sub_TestKledg0001', customer: 'cus_TestOwner0001', status: 'canceled', endedAt: new Date() })
    const response = await deliver(stripeEvent('customer.subscription.deleted', live.sub_TestKledg0001))
    expect(await response.json()).toEqual({ received: true, status: 'ignored' })
    expect(await account()).toMatchObject({ stripeSubscriptionId: 'sub_TestKledg0002', subscriptionStatus: 'active', planId: 'cabinet' })
  })

  it('acknowledges and ignores foreign customers, other events and one-time checkouts', async () => {
    live.sub_TestKledg0001 = subscriptionObject({ id: 'sub_TestKledg0001', customer: 'cus_SomebodyElse01', status: 'active' })
    const foreign = await deliver(stripeEvent('customer.subscription.created', live.sub_TestKledg0001))
    const other = await deliver(stripeEvent('customer.created', { id: 'cus_TestOwner0001', object: 'customer' }))
    const payment = await deliver(
      stripeEvent(
        'checkout.session.completed',
        checkoutSessionObject({ id: 'cs_TestKledg0004', customer: 'cus_TestOwner0001', subscription: '', clientReferenceId: 'ba-owner', mode: 'payment' }),
      ),
    )
    for (const response of [foreign, other, payment]) {
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ received: true, status: 'ignored' })
    }
    expect((await account()).stripeCustomerId).toBeNull()
    expect(await prisma.cloudStripeEvent.count()).toBe(3)
  })

  it('never lets a checkout adopt an account that already has another customer', async () => {
    await prisma.cloudBillingAccount.update({ where: { id: 'ba-owner' }, data: { stripeCustomerId: 'cus_TestOwner0001' } })
    live.sub_TestKledg0002 = subscriptionObject({ id: 'sub_TestKledg0002', customer: 'cus_SomebodyElse01', status: 'active' })
    const response = await deliver(
      stripeEvent(
        'checkout.session.completed',
        checkoutSessionObject({ id: 'cs_TestKledg0005', customer: 'cus_SomebodyElse01', subscription: 'sub_TestKledg0002', clientReferenceId: 'ba-owner' }),
      ),
    )
    expect(await response.json()).toEqual({ received: true, status: 'ignored' })
    expect(await account()).toMatchObject({ stripeCustomerId: 'cus_TestOwner0001', stripeSubscriptionId: null })
  })

  it('records nothing when Stripe cannot be read (502), so the retry applies the event', async () => {
    const event = stripeEvent(
      'checkout.session.completed',
      checkoutSessionObject({ id: 'cs_TestKledg0006', customer: 'cus_TestOwner0001', subscription: 'sub_TestKledg0001', clientReferenceId: 'ba-owner' }),
    )
    // No subscription on the API: Stripe answers 404.
    const failed = await deliver(event)
    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({ error: "L'événement Stripe n'a pas pu être appliqué." })
    expect(await prisma.cloudStripeEvent.count()).toBe(0)

    live.sub_TestKledg0001 = subscriptionObject({ id: 'sub_TestKledg0001', customer: 'cus_TestOwner0001', status: 'trialing' })
    expect(await (await deliver(event)).json()).toEqual({ received: true, status: 'applied' })
    expect((await account()).subscriptionStatus).toBe('trialing')
  })
})

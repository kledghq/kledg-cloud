/**
 * Checkout, Customer Portal and invoices (app/api/billing/*) against
 * PostgreSQL, through the real routes and the real Stripe SDK on a mocked
 * fetch: what is sent to Stripe (Stripe Tax, tax id collection, the trial
 * kept, an idempotent customer), what is refused, and that nothing works
 * outside cloud mode or without a session.
 *
 * Skipped when the test database server is unreachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = await vi.hoisted(async () => {
  const { useTestDatabase } = await import('@/lib/__tests__/helpers/test-db')
  useTestDatabase('cloud_checkout')
  process.env.BETTER_AUTH_SECRET ??= 'kledg-test-secret-0123456789abcdef0123456789'
  process.env.BETTER_AUTH_URL = 'https://app.kledg.test'
  process.env.RATE_LIMIT_DISABLED = 'true'
  return { user: null as null | { id: string; email: string; name: string | null; role: string | null }, stripe: null as unknown }
})

vi.mock('@/lib/session', () => ({ getCurrentUser: async () => state.user }))
vi.mock('@/lib/cloud/billing/stripe', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/cloud/billing/stripe')>()
  return { ...real, getStripe: () => state.stripe }
})

import { prepareTestDatabase, testDatabaseAvailable } from '@/lib/__tests__/helpers/test-db'
import { invoiceObject, PRICE_ENV, PRICES, stripeFetch } from '../../__tests__/helpers/stripe-fixtures'

const available = await testDatabaseAvailable()

type Handler = (request: Request) => Promise<Response>
let prisma: typeof import('@/lib/prisma').prisma
const routes = {} as Record<'checkout' | 'portal' | 'invoices', Record<string, Handler>>
let api: ReturnType<typeof stripeFetch>

const OWNER = { id: 'u-owner', email: 'owner@test.local', name: 'Claire Martin', role: 'user' }

function call(route: keyof typeof routes, method: 'GET' | 'POST', body?: unknown) {
  return routes[route][method](
    new NextRequest(`http://localhost/api/billing/${route}`, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    }),
  )
}

const form = (body: string) => Object.fromEntries(new URLSearchParams(body))

describe.skipIf(!available)('checkout, portal and invoices', () => {
  beforeAll(async () => {
    await prepareTestDatabase('cloud_checkout')
    ;({ prisma } = await import('@/lib/prisma'))
    routes.checkout = (await import('@/app/api/billing/checkout/route')) as unknown as Record<string, Handler>
    routes.portal = (await import('@/app/api/billing/portal/route')) as unknown as Record<string, Handler>
    routes.invoices = (await import('@/app/api/billing/invoices/route')) as unknown as Record<string, Handler>
    await prisma.user.create({ data: { id: OWNER.id, email: OWNER.email, name: OWNER.name, role: 'user', emailVerified: true } })
  }, 120_000)

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  beforeEach(async () => {
    vi.stubEnv('KLEDG_CLOUD_MODE', 'true')
    for (const [name, value] of Object.entries(PRICE_ENV)) vi.stubEnv(name, value)
    state.user = { ...OWNER }
    await prisma.cloudBillingAccount.deleteMany()
    api = stripeFetch({
      'POST /v1/customers': { id: 'cus_TestOwner0001', object: 'customer', email: OWNER.email },
      'POST /v1/checkout/sessions': { id: 'cs_TestKledg0001', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_TestKledg0001' },
      'POST /v1/billing_portal/sessions': { id: 'bps_TestKledg01', object: 'billing_portal.session', url: 'https://billing.stripe.com/p/session/test_1' },
      'GET /v1/invoices': {
        object: 'list',
        has_more: false,
        url: '/v1/invoices',
        data: [
          invoiceObject({ id: 'in_TestKledg0001', customer: 'cus_TestOwner0001', subscription: 'sub_TestKledg0001' }),
          { ...invoiceObject({ id: 'in_TestKledg0002', customer: 'cus_TestOwner0001', subscription: null }), hosted_invoice_url: 'https://evil.example/i' },
          { ...invoiceObject({ id: 'in_TestKledg0003', customer: 'cus_TestOwner0001', subscription: null }), status: 'draft' },
        ],
      },
    })
    state.stripe = api.stripe
  })

  it('opens a Checkout session with Stripe Tax, tax id collection, the address and the trial kept', async () => {
    const trialEndsAt = new Date(Date.now() + 20 * 86_400_000)
    await prisma.cloudBillingAccount.create({ data: { id: 'ba-owner', ownerUserId: OWNER.id, trialEndsAt } })
    const response = await call('checkout', 'POST', { plan: 'holding', interval: 'year' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_TestKledg0001' })

    const [customer, session] = api.calls
    expect(customer).toMatchObject({ method: 'POST', path: '/v1/customers', idempotencyKey: 'kledg-cloud-customer-ba-owner' })
    expect(form(customer.body)).toMatchObject({ email: OWNER.email, name: 'Claire Martin', 'metadata[billing_account_id]': 'ba-owner' })
    expect(session.path).toBe('/v1/checkout/sessions')
    expect(form(session.body)).toMatchObject({
      mode: 'subscription',
      customer: 'cus_TestOwner0001',
      client_reference_id: 'ba-owner',
      'line_items[0][price]': PRICES.holdingYearly,
      'line_items[0][quantity]': '1',
      'automatic_tax[enabled]': 'true',
      'tax_id_collection[enabled]': 'true',
      'customer_update[address]': 'auto',
      'customer_update[name]': 'auto',
      billing_address_collection: 'required',
      locale: 'fr',
      'subscription_data[metadata][billing_account_id]': 'ba-owner',
      'subscription_data[trial_end]': String(Math.floor(trialEndsAt.getTime() / 1000)),
      success_url: 'https://app.kledg.test/settings/billing?checkout=success',
      cancel_url: 'https://app.kledg.test/settings/billing?checkout=cancel',
    })
    expect((await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { id: 'ba-owner' } })).stripeCustomerId).toBe('cus_TestOwner0001')
  })

  it('creates the account of a user without one, reuses the customer, and drops an expired trial', async () => {
    await prisma.cloudBillingAccount.create({
      data: { ownerUserId: OWNER.id, stripeCustomerId: 'cus_TestOwner0001', trialEndsAt: new Date(Date.now() - 86_400_000) },
    })
    expect((await call('checkout', 'POST', { plan: 'essentiel' })).status).toBe(200)
    expect(api.calls.map((c) => c.path)).toEqual(['/v1/checkout/sessions'])
    const sent = form(api.calls[0].body)
    expect(sent['line_items[0][price]']).toBe(PRICES.essentielMonthly)
    expect(sent['subscription_data[trial_end]']).toBeUndefined()
  })

  it('refuses a second subscription, a deletion in progress, an unknown plan and an unpriced interval', async () => {
    await prisma.cloudBillingAccount.create({
      data: { id: 'ba-owner', ownerUserId: OWNER.id, subscriptionStatus: 'past_due', trialEndsAt: new Date() },
    })
    const live = await call('checkout', 'POST', { plan: 'cabinet' })
    expect(live.status).toBe(409)
    expect(((await live.json()) as { error: string }).error).toMatch(/^Vous avez déjà un abonnement/)

    await prisma.cloudBillingAccount.update({ where: { id: 'ba-owner' }, data: { subscriptionStatus: 'canceled', deletionScheduledFor: new Date() } })
    expect((await call('checkout', 'POST', { plan: 'cabinet' })).status).toBe(409)

    const unknown = await call('checkout', 'POST', { plan: 'gold' })
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toMatchObject({ error: 'plan: Offre inconnue.' })
    const unpriced = await call('checkout', 'POST', { plan: 'cabinet', interval: 'year' })
    expect(unpriced.status).toBe(400)
    expect(api.calls).toEqual([])
  })

  it('answers 502 in French when Stripe fails', async () => {
    api = stripeFetch({ 'POST /v1/customers': () => ({ status: 400, body: { error: { type: 'invalid_request_error', message: 'boom' } } }) })
    state.stripe = api.stripe
    const response = await call('checkout', 'POST', { plan: 'holding' })
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: "Stripe n'a pas répondu. Réessayez dans quelques instants." })
  })

  it('opens the Customer Portal only for an account with a Stripe customer', async () => {
    const none = await call('portal', 'POST')
    expect(none.status).toBe(409)
    await prisma.cloudBillingAccount.create({ data: { ownerUserId: OWNER.id, stripeCustomerId: 'cus_TestOwner0001', trialEndsAt: new Date() } })
    const response = await call('portal', 'POST')
    expect(await response.json()).toEqual({ url: 'https://billing.stripe.com/p/session/test_1' })
    expect(form(api.calls[0].body)).toEqual({ customer: 'cus_TestOwner0001', return_url: 'https://app.kledg.test/settings/billing', locale: 'fr' })
  })

  it('lists the invoices, without drafts and without links that do not point to Stripe', async () => {
    expect(await (await call('invoices', 'GET')).json()).toEqual({ invoices: [] })
    expect(api.calls).toEqual([])
    await prisma.cloudBillingAccount.create({ data: { ownerUserId: OWNER.id, stripeCustomerId: 'cus_TestOwner0001', trialEndsAt: new Date() } })
    const { invoices } = (await (await call('invoices', 'GET')).json()) as { invoices: Array<Record<string, unknown>> }
    expect(invoices).toEqual([
      {
        id: 'in_TestKledg0001',
        number: 'KLEDG-0001',
        date: '2026-10-20',
        totalCents: 3480,
        currency: 'eur',
        status: 'paid',
        hostedUrl: 'https://invoice.stripe.com/i/acct_Test/in_TestKledg0001',
        pdfUrl: 'https://pay.stripe.com/invoice/acct_Test/in_TestKledg0001/pdf',
      },
      expect.objectContaining({ id: 'in_TestKledg0002', hostedUrl: null }),
    ])
    expect(form(api.calls[0].body)).toEqual({ customer: 'cus_TestOwner0001', limit: '24' })
  })

  it('is closed to anonymous callers and outside cloud mode', async () => {
    state.user = null
    expect((await call('checkout', 'POST', { plan: 'holding' })).status).toBe(401)
    expect((await call('portal', 'POST')).status).toBe(401)
    expect((await call('invoices', 'GET')).status).toBe(401)
    state.user = { ...OWNER }
    vi.stubEnv('KLEDG_CLOUD_MODE', '')
    expect((await call('checkout', 'POST', { plan: 'holding' })).status).toBe(404)
    expect((await call('portal', 'POST')).status).toBe(404)
    expect((await call('invoices', 'GET')).status).toBe(404)
    expect(api.calls).toEqual([])
  })
})

/**
 * Checkout, Customer Portal and invoices (app/api/billing/*) against
 * PostgreSQL, through the real routes and the real Stripe SDK on a mocked
 * fetch: prices resolved by lookup key, the free trial (30 days, no card,
 * cancelled without a payment method, one per client), Stripe Tax and tax
 * id collection, Cabinet extra companies, an idempotent customer; what is
 * refused; nothing outside cloud mode or without a session.
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
import { seedMembership } from '@/lib/__tests__/helpers/membership'
import { clearPriceCache } from '@/lib/cloud/billing/stripe-prices'
import { form, invoiceObject, pricesList, stripeFetch } from '../../__tests__/helpers/stripe-fixtures'

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

const session = () => form(api.calls.find((c) => c.path === '/v1/checkout/sessions')?.body ?? '')

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
    state.user = { ...OWNER }
    clearPriceCache()
    await prisma.cloudCompanyOwnership.deleteMany()
    await prisma.member.deleteMany()
    await prisma.organization.deleteMany()
    await prisma.company.deleteMany()
    await prisma.cloudBillingAccount.deleteMany()
    api = stripeFetch({
      'GET /v1/prices': pricesList(),
      'POST /v1/customers': { id: 'cus_TestOwner0001', object: 'customer', email: OWNER.email },
      'POST /v1/checkout/sessions': { id: 'cs_TestKledg0001', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_TestKledg0001' },
      'POST /v1/billing_portal/sessions': { id: 'bps_TestKledg01', object: 'billing_portal.session', url: 'https://billing.stripe.com/p/session/test_1' },
      'GET /v1/invoices': {
        object: 'list',
        has_more: false,
        url: '/v1/invoices',
        data: [
          invoiceObject({ id: 'in_TestKledg0001', customer: 'cus_TestOwner0001', subscription: 'sub_TestKledg0001', discountCents: 3120 }),
          { ...invoiceObject({ id: 'in_TestKledg0002', customer: 'cus_TestOwner0001', subscription: null }), hosted_invoice_url: 'https://evil.example/i' },
          { ...invoiceObject({ id: 'in_TestKledg0003', customer: 'cus_TestOwner0001', subscription: null }), status: 'draft' },
        ],
      },
    })
    state.stripe = api.stripe
  })

  it('starts the free trial at Checkout: 30 days, no card, ending without a payment method, with Stripe Tax and tax ids', async () => {
    const response = await call('checkout', 'POST', { plan: 'holding', interval: 'year' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_TestKledg0001' })

    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/prices', 'POST /v1/customers', 'POST /v1/checkout/sessions'])
    const account = await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { ownerUserId: OWNER.id } })
    expect(api.calls[1].idempotencyKey).toBe(`kledg-cloud-customer-${account.id}`)
    expect(form(api.calls[1].body)).toMatchObject({ email: OWNER.email, name: 'Claire Martin', 'metadata[billing_account_id]': account.id })
    expect(session()).toMatchObject({
      mode: 'subscription',
      customer: 'cus_TestOwner0001',
      client_reference_id: account.id,
      'line_items[0][price]': 'price_TestHoldingYear',
      'line_items[0][quantity]': '1',
      'automatic_tax[enabled]': 'true',
      'tax_id_collection[enabled]': 'true',
      'customer_update[address]': 'auto',
      'customer_update[name]': 'auto',
      billing_address_collection: 'required',
      allow_promotion_codes: 'true',
      locale: 'fr',
      payment_method_collection: 'if_required',
      'subscription_data[trial_period_days]': '30',
      'subscription_data[trial_settings][end_behavior][missing_payment_method]': 'cancel',
      'subscription_data[metadata][billing_account_id]': account.id,
      success_url: 'https://app.kledg.test/settings/billing?checkout=success',
      cancel_url: 'https://app.kledg.test/settings/billing?checkout=cancel',
    })
    expect(account.stripeCustomerId).toBe('cus_TestOwner0001')
  })

  it('offers one trial per client: a client who already had one pays from the start, card required', async () => {
    await prisma.cloudBillingAccount.create({
      data: { ownerUserId: OWNER.id, stripeCustomerId: 'cus_TestOwner0001', trialUsed: true, subscriptionStatus: 'canceled', stripeSubscriptionId: 'sub_Old' },
    })
    expect((await call('checkout', 'POST', { plan: 'essentiel' })).status).toBe(200)
    expect(api.calls.map((c) => c.path)).toEqual(['/v1/prices', '/v1/checkout/sessions'])
    expect(session()).toMatchObject({ 'line_items[0][price]': 'price_TestEssentielMonth', payment_method_collection: 'always' })
    expect(session()['subscription_data[trial_period_days]']).toBeUndefined()
  })

  it('bills the companies of a returning Cabinet account beyond the 25 included', async () => {
    const account = await prisma.cloudBillingAccount.create({ data: { ownerUserId: OWNER.id, trialUsed: true, subscriptionStatus: 'canceled' } })
    for (let i = 0; i < 27; i++) {
      const company = await prisma.company.create({ data: { name: `Client ${i}`, slug: `client-${i}`, siren: String(100000000 + i) } })
      await seedMembership(prisma, OWNER.id, company.id, 'companyAdmin')
      await prisma.cloudCompanyOwnership.create({ data: { companyId: company.id, billingAccountId: account.id } })
    }
    expect((await call('checkout', 'POST', { plan: 'cabinet', interval: 'month' })).status).toBe(200)
    expect(session()).toMatchObject({
      'line_items[0][price]': 'price_TestCabinetMonth',
      'line_items[1][price]': 'price_TestCabinetExtraCompanyMonth',
      'line_items[1][quantity]': '2',
    })
  })

  it('refuses a second subscription, a deletion in progress, an unknown plan and a price Stripe does not have', async () => {
    await prisma.cloudBillingAccount.create({ data: { id: 'ba-owner', ownerUserId: OWNER.id, subscriptionStatus: 'past_due' } })
    const live = await call('checkout', 'POST', { plan: 'cabinet' })
    expect(live.status).toBe(409)
    expect(((await live.json()) as { error: string }).error).toMatch(/^Vous avez déjà un abonnement/)

    await prisma.cloudBillingAccount.update({
      where: { id: 'ba-owner' },
      data: { subscriptionStatus: 'canceled', deletionScheduledFor: new Date(), deletionReason: 'requested' },
    })
    expect((await call('checkout', 'POST', { plan: 'cabinet' })).status).toBe(409)
    await prisma.cloudBillingAccount.update({ where: { id: 'ba-owner' }, data: { deletionScheduledFor: null, deletionReason: null } })

    const unknown = await call('checkout', 'POST', { plan: 'gold' })
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toMatchObject({ error: 'plan: Offre inconnue.' })

    api = stripeFetch({ 'GET /v1/prices': pricesList(['essentiel']) })
    state.stripe = api.stripe
    clearPriceCache()
    const unpriced = await call('checkout', 'POST', { plan: 'cabinet', interval: 'year' })
    expect(unpriced.status).toBe(400)
    expect(api.calls.map((c) => c.path)).toEqual(['/v1/prices'])
  })

  it('answers 502 in French when Stripe fails', async () => {
    api = stripeFetch({ 'GET /v1/prices': pricesList(), 'POST /v1/customers': () => ({ status: 400, body: { error: { type: 'invalid_request_error', message: 'boom' } } }) })
    state.stripe = api.stripe
    const response = await call('checkout', 'POST', { plan: 'holding' })
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: "Stripe n'a pas répondu. Réessayez dans quelques instants." })
  })

  it('opens the Customer Portal (default configuration) only for an account with a Stripe customer', async () => {
    expect((await call('portal', 'POST')).status).toBe(409)
    await prisma.cloudBillingAccount.create({ data: { ownerUserId: OWNER.id, stripeCustomerId: 'cus_TestOwner0001' } })
    const response = await call('portal', 'POST')
    expect(await response.json()).toEqual({ url: 'https://billing.stripe.com/p/session/test_1' })
    expect(form(api.calls[0].body)).toEqual({ customer: 'cus_TestOwner0001', return_url: 'https://app.kledg.test/settings/billing', locale: 'fr' })
  })

  it('lists the invoices, without drafts and without links that do not point to Stripe', async () => {
    expect(await (await call('invoices', 'GET')).json()).toEqual({ invoices: [] })
    expect(api.calls).toEqual([])
    await prisma.cloudBillingAccount.create({ data: { ownerUserId: OWNER.id, stripeCustomerId: 'cus_TestOwner0001' } })
    const { invoices } = (await (await call('invoices', 'GET')).json()) as { invoices: Array<Record<string, unknown>> }
    expect(invoices).toEqual([
      {
        id: 'in_TestKledg0001',
        number: 'KLEDG-0001',
        date: '2026-10-20',
        totalCents: 4680,
        discountCents: 3120,
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

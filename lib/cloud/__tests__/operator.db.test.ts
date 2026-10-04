/**
 * Operator side of Kledg Cloud against PostgreSQL, Stripe mocked:
 * - the console routes are for instance administrators only (403 for a
 *   customer, 401 anonymous, 404 outside cloud mode); they list accounts
 *   with plan, state, trial end and companies, and extend a running trial
 *   on the Stripe subscription (audited), nothing else;
 * - Cabinet extra companies follow the companies owned (update, removal);
 * - a requested deletion of a still-paying account cancels its Stripe
 *   subscription before deleting.
 *
 * Skipped when the test database server is unreachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = await vi.hoisted(async () => {
  const { useTestDatabase } = await import('@/lib/__tests__/helpers/test-db')
  useTestDatabase('cloud_operator')
  process.env.BETTER_AUTH_SECRET ??= 'kledg-test-secret-0123456789abcdef0123456789'
  process.env.BETTER_AUTH_URL ??= 'http://localhost:3000'
  process.env.RATE_LIMIT_DISABLED = 'true'
  return { user: null as null | { id: string; email: string; name: string | null; role: string | null }, stripe: null as unknown }
})

vi.mock('@/lib/session', () => ({ getCurrentUser: async () => state.user }))
vi.mock('@/lib/cloud/billing/stripe', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/cloud/billing/stripe')>()
  return { ...real, getStripe: () => state.stripe }
})

import { prepareTestDatabase, testDatabaseAvailable } from '@/lib/__tests__/helpers/test-db'
import { form, stripeFetch, subscriptionObject } from './helpers/stripe-fixtures'

const available = await testDatabaseAvailable()

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>
let prisma: typeof import('@/lib/prisma').prisma
const routes = {} as Record<'list' | 'trial', Record<string, Handler>>

const ADMIN = { id: 'u-admin', email: 'operator@test.local', name: 'Opérateur', role: 'admin' }
const CUSTOMER = { id: 'u-customer', email: 'customer@test.local', name: 'Claire', role: 'user' }

const list = (query = '') => routes.list.GET(new NextRequest(`http://localhost/api/cloud/operator/accounts${query}`))
const extend = (id: string, days: unknown) =>
  routes.trial.POST(
    new NextRequest(`http://localhost/api/cloud/operator/accounts/${id}/trial`, {
      method: 'POST',
      body: JSON.stringify({ days }),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id }) },
  )

describe.skipIf(!available)('operator console', () => {
  beforeAll(async () => {
    await prepareTestDatabase('cloud_operator')
    ;({ prisma } = await import('@/lib/prisma'))
    routes.list = (await import('@/app/api/cloud/operator/accounts/route')) as unknown as Record<string, Handler>
    routes.trial = (await import('@/app/api/cloud/operator/accounts/[id]/trial/route')) as unknown as Record<string, Handler>
    for (const user of [ADMIN, CUSTOMER]) await prisma.user.create({ data: { ...user, emailVerified: true } })
    await prisma.cloudBillingAccount.create({
      data: {
        id: 'ba-customer',
        ownerUserId: CUSTOMER.id,
        stripeSubscriptionId: 'sub_TestKledg0001',
        subscriptionStatus: 'trialing',
        planId: 'holding',
        billingInterval: 'month',
        trialEnd: new Date('2026-11-20T00:00:00Z'),
        trialUsed: true,
      },
    })
    const company = await prisma.company.create({ data: { name: 'Atelier', slug: 'atelier', siren: '912345675' } })
    await prisma.cloudCompanyOwnership.create({ data: { companyId: company.id, billingAccountId: 'ba-customer' } })
  }, 120_000)

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  beforeEach(() => {
    vi.stubEnv('KLEDG_CLOUD_MODE', 'true')
    state.user = { ...ADMIN }
  })

  it('is closed to customers (403), anonymous callers (401), and outside cloud mode (404)', async () => {
    state.user = { ...CUSTOMER }
    expect((await list()).status).toBe(403)
    expect((await extend('ba-customer', 7)).status).toBe(403)
    state.user = null
    expect((await list()).status).toBe(401)
    expect((await extend('ba-customer', 7)).status).toBe(401)
    state.user = { ...ADMIN }
    vi.stubEnv('KLEDG_CLOUD_MODE', '')
    expect((await list()).status).toBe(404)
    expect(await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { id: 'ba-customer' } })).toMatchObject({ trialEnd: new Date('2026-11-20T00:00:00Z') })
  })

  it('lists the accounts with owner, plan, state, trial end and companies; searches by address', async () => {
    const response = await list()
    expect(response.status).toBe(200)
    const body = (await response.json()) as { accounts: Array<Record<string, unknown>>; nextCursor: string | null }
    expect(body.nextCursor).toBeNull()
    expect(body.accounts).toEqual([
      expect.objectContaining({
        id: 'ba-customer',
        ownerEmail: CUSTOMER.email,
        planId: 'holding',
        phase: expect.any(String),
        subscriptionStatus: 'trialing',
        trialEnd: '2026-11-20T00:00:00.000Z',
        companies: 1,
      }),
    ])
    // No secret or Stripe identifier leaves the server.
    expect(JSON.stringify(body)).not.toMatch(/sub_|cus_/)
    expect(((await (await list('?search=nobody')).json()) as { accounts: unknown[] }).accounts).toEqual([])
  })

  it('extends a running trial on Stripe from its current end, audited; refuses outside a trial', async () => {
    const api = stripeFetch({ 'POST /v1/subscriptions/sub_TestKledg0001': { id: 'sub_TestKledg0001', object: 'subscription', status: 'trialing' } })
    state.stripe = api.stripe
    expect((await extend('ba-customer', 0)).status).toBe(400)
    expect((await extend('ba-customer', 61)).status).toBe(400)
    const before = new Date('2026-11-20T00:00:00Z')
    const now = Date.now()
    const from = before.getTime() > now ? before.getTime() : now
    const response = await extend('ba-customer', 14)
    expect(response.status).toBe(200)
    const { trialEnd } = (await response.json()) as { trialEnd: string }
    expect(new Date(trialEnd).getTime() - from).toBeGreaterThanOrEqual(14 * 86_400_000 - 5_000)
    expect(form(api.calls[0].body)).toEqual({ trial_end: String(Math.floor(new Date(trialEnd).getTime() / 1000)), proration_behavior: 'none' })
    expect(await prisma.auditLog.count({ where: { action: 'CLOUD_TRIAL_EXTENDED' } })).toBe(1)

    await prisma.cloudBillingAccount.update({ where: { id: 'ba-customer' }, data: { subscriptionStatus: 'active' } })
    const refused = await extend('ba-customer', 7)
    expect(refused.status).toBe(409)
    expect((await extend('missing', 7)).status).toBe(404)
  })
})

describe.skipIf(!available)('Cabinet extra companies and deletion of a paying account', () => {
  beforeEach(() => vi.stubEnv('KLEDG_CLOUD_MODE', 'true'))

  it('updates the quantity, removes the line when back under 25, and cancels a live subscription before a deletion', async () => {
    const { syncCabinetExtraCompanies } = await import('../billing/cabinet-extra.service')
    const { executeAccountDeletion } = await import('../account/account-deletion.service')
    await prisma.user.create({ data: { id: 'u-cab', email: 'cab@test.local', name: 'Cabinet', role: 'user', emailVerified: true } })
    const account = await prisma.cloudBillingAccount.create({
      data: { ownerUserId: 'u-cab', stripeSubscriptionId: 'sub_TestCabinet01', subscriptionStatus: 'active', planId: 'cabinet', billingInterval: 'month', extraCompanies: 2 },
    })
    const companies = []
    for (let i = 0; i < 28; i++) {
      const c = await prisma.company.create({ data: { name: `C${i}`, slug: `c-${i}`, siren: String(300000000 + i) } })
      await prisma.cloudCompanyOwnership.create({ data: { companyId: c.id, billingAccountId: account.id } })
      companies.push(c.id)
    }
    const subscription = subscriptionObject({ id: 'sub_TestCabinet01', customer: 'cus_TestCabinet01', status: 'active', plan: 'cabinet', extraCompanies: 2 })
    const api = stripeFetch({
      'GET /v1/subscriptions/sub_TestCabinet01': subscription,
      'POST /v1/subscription_items/si_TestCabinet01X': { id: 'si_TestCabinet01X', object: 'subscription_item', quantity: 3 },
      'DELETE /v1/subscription_items/si_TestCabinet01X': { id: 'si_TestCabinet01X', object: 'subscription_item', deleted: true },
      'DELETE /v1/subscriptions/sub_TestCabinet01': { ...subscription, status: 'canceled' },
    })
    expect(await syncCabinetExtraCompanies(account, api.stripe)).toBe(3)
    expect(form(api.calls[1].body)).toEqual({ quantity: '3', proration_behavior: 'create_prorations' })

    await prisma.company.updateMany({ where: { id: { in: companies.slice(0, 4) } }, data: { archivedAt: new Date() } })
    const fresh = await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { id: account.id } })
    expect(await syncCabinetExtraCompanies(fresh, api.stripe)).toBe(0)
    expect(api.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/subscription_items/si_TestCabinet01X' })

    await prisma.cloudBillingAccount.update({ where: { id: account.id }, data: { deletionScheduledFor: new Date(), deletionReason: 'requested' } })
    const outcome = await executeAccountDeletion(account.id, { stripe: () => api.stripe })
    expect(outcome.companies).toHaveLength(28)
    expect(api.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/subscriptions/sub_TestCabinet01' })
    expect(await prisma.company.count({ where: { id: { in: companies } } })).toBe(0)
    expect(await prisma.user.findUnique({ where: { id: 'u-cab' } })).toBeNull()
  })
})

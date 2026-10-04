/**
 * What the Facturation page shows (loadBillingOverview) against PostgreSQL:
 * a new user sees the trial to start, an owner its plan, usage and the
 * plans with their Stripe prices; Stripe failures never break the page.
 *
 * Skipped when the test database server is unreachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

await vi.hoisted(async () => {
  const { useTestDatabase } = await import('@/lib/__tests__/helpers/test-db')
  useTestDatabase('cloud_billing_overview')
})

import { prepareTestDatabase, testDatabaseAvailable } from '@/lib/__tests__/helpers/test-db'
import { clearPriceCache } from '@/lib/cloud/billing/stripe-prices'
import { pricesList, stripeFetch, TEST_SECRET_KEY } from '../../__tests__/helpers/stripe-fixtures'

const available = await testDatabaseAvailable()
let prisma: typeof import('@/lib/prisma').prisma
let loadBillingOverview: typeof import('../billing-overview.service').loadBillingOverview

const user = { id: 'u-owner', email: 'owner@test.local', name: 'Claire', role: 'user' }
const now = new Date('2026-11-10T09:00:00Z')

describe.skipIf(!available)('billing overview', () => {
  beforeAll(async () => {
    await prepareTestDatabase('cloud_billing_overview')
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ loadBillingOverview } = await import('../billing-overview.service'))
  }, 120_000)

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  beforeEach(() => {
    clearPriceCache()
    vi.stubEnv('STRIPE_SECRET_KEY', '')
  })

  it('shows a new user the trial to start, without plans until Stripe is set up', async () => {
    expect(await loadBillingOverview(user, now)).toEqual({
      phase: 'none',
      reason: 'no_subscription',
      writable: false,
      planId: null,
      planName: null,
      billingInterval: null,
      companyCount: 0,
      companyLimit: 0,
      extraCompanies: 0,
      trialEndsAt: null,
      readOnlyAt: null,
      retrievalEndsAt: null,
      deletionAt: null,
      endsAt: null,
      trialAvailable: true,
      trialDays: 30,
      subscribed: false,
      hasCustomer: false,
      stripeConfigured: false,
      plans: [],
    })
    expect(await prisma.cloudBillingAccount.count()).toBe(0)
  })

  it("shows an owner's plan, usage and the plans with their prices", async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', TEST_SECRET_KEY)
    const api = stripeFetch({ 'GET /v1/prices': pricesList() })
    const account = await prisma.cloudBillingAccount.create({
      data: {
        ownerUserId: user.id,
        stripeCustomerId: 'cus_TestOwner0001',
        stripeSubscriptionId: 'sub_TestKledg0001',
        subscriptionStatus: 'trialing',
        planId: 'holding',
        billingInterval: 'month',
        trialUsed: true,
        trialEnd: new Date('2026-11-20T00:00:00Z'),
      },
    })
    const company = await prisma.company.create({ data: { name: 'Atelier', slug: 'atelier', siren: '912345675' } })
    const archived = await prisma.company.create({ data: { name: 'Ancienne', slug: 'ancienne', siren: '912345683', archivedAt: now } })
    await prisma.cloudCompanyOwnership.createMany({
      data: [
        { companyId: company.id, billingAccountId: account.id },
        { companyId: archived.id, billingAccountId: account.id },
      ],
    })
    const overview = await loadBillingOverview(user, now, () => api.stripe)
    expect(overview).toMatchObject({
      phase: 'trial',
      planName: 'Holding',
      billingInterval: 'month',
      companyCount: 1,
      companyLimit: 5,
      trialEndsAt: '2026-11-20T00:00:00.000Z',
      trialAvailable: false,
      subscribed: true,
      hasCustomer: true,
      stripeConfigured: true,
    })
    expect(overview.plans.map((p) => [p.id, p.prices, p.extraCompany])).toEqual([
      ['essentiel', { month: 1500, year: 15000 }, {}],
      ['holding', { month: 3900, year: 39000 }, {}],
      ['cabinet', { month: 9900, year: 99000 }, { month: 300, year: 3000 }],
    ])
  })

  it('still answers when Stripe does not', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', TEST_SECRET_KEY)
    const api = stripeFetch({ 'GET /v1/prices': () => ({ status: 500, body: { error: { type: 'api_error', message: 'down' } } }) })
    const overview = await loadBillingOverview(user, now, () => api.stripe)
    expect(overview.plans).toEqual([])
    expect(overview.phase).toBe('trial')
  })
})

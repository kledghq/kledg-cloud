/**
 * What the Facturation page shows (loadBillingOverview) against PostgreSQL:
 * a member without an account sees the trial it would start, an owner its
 * plan and usage, and only the plans whose Stripe price is configured.
 *
 * Skipped when the test database server is unreachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

await vi.hoisted(async () => {
  const { useTestDatabase } = await import('@/lib/__tests__/helpers/test-db')
  useTestDatabase('cloud_billing_overview')
})

import { prepareTestDatabase, testDatabaseAvailable } from '@/lib/__tests__/helpers/test-db'
import { PRICE_ENV, TEST_SECRET_KEY } from '../../__tests__/helpers/stripe-fixtures'

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
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    for (const name of Object.keys(PRICE_ENV)) vi.stubEnv(name, '')
  })

  it('shows a member without an account the trial it would start, without plans until Stripe is set up', async () => {
    expect(await loadBillingOverview(user, now)).toEqual({
      phase: 'trial',
      reason: null,
      writable: true,
      planId: null,
      planName: null,
      companyCount: 0,
      companyLimit: 3,
      trialEndsAt: '2026-12-10T09:00:00.000Z',
      readOnlyAt: null,
      endsAt: null,
      subscribed: false,
      hasCustomer: false,
      stripeConfigured: false,
      deletionScheduledFor: null,
      plans: [],
    })
    expect(await prisma.cloudBillingAccount.count()).toBe(0)
  })

  it("shows an owner's plan, usage and the configured plans", async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', TEST_SECRET_KEY)
    for (const [name, value] of Object.entries(PRICE_ENV)) vi.stubEnv(name, value)
    const account = await prisma.cloudBillingAccount.create({
      data: {
        ownerUserId: user.id,
        trialEndsAt: new Date('2026-10-01T00:00:00Z'),
        stripeCustomerId: 'cus_TestOwner0001',
        subscriptionStatus: 'active',
        planId: 'holding',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
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
    const overview = await loadBillingOverview(user, now)
    expect(overview).toMatchObject({
      phase: 'active',
      planId: 'holding',
      planName: 'Holding',
      companyCount: 1,
      companyLimit: 5,
      endsAt: '2026-12-01T00:00:00.000Z',
      subscribed: true,
      hasCustomer: true,
      stripeConfigured: true,
    })
    expect(overview.plans.map((p) => [p.id, p.intervals])).toEqual([
      ['essentiel', ['month']],
      ['holding', ['month', 'year']],
      ['cabinet', ['month']],
    ])
  })
})

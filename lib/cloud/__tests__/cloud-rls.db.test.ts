/**
 * Row level security of the Kledg Cloud tables (migration
 * 20261021090000_cloud_billing, docs/rls.md, docs/cloud.md), always under
 * KLEDG_RLS=enforce with the application role:
 * - a billing account is read by its owner and by the members of the
 *   companies it owns (the read-only check runs for them), written by its
 *   owner only; another user sees nothing;
 * - ownership rows follow the companies' reachability;
 * - terms acceptances are each user's own;
 * - Stripe event ids are reachable by unrestricted contexts only;
 * - without a context nothing is read and writes are refused.
 *
 * Skipped when the test database server is unreachable.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const previous = await vi.hoisted(async () => {
  const before = { rls: process.env.KLEDG_RLS, fallback: process.env.KLEDG_RLS_TEST_CONTEXT }
  process.env.KLEDG_RLS = 'enforce'
  const { useTestDatabase } = await import('@/lib/__tests__/helpers/test-db')
  useTestDatabase('cloud_rls')
  delete process.env.KLEDG_RLS_TEST_CONTEXT
  return before
})

import { prepareTestDatabase, testDatabaseAvailable } from '@/lib/__tests__/helpers/test-db'
import { prisma } from '@/lib/prisma'
import { withSystemContext, withUserContext } from '@/lib/rls/context'

const available = await testDatabaseAvailable()

const OWNER = 'u-owner'
const MEMBER = 'u-member'
const STRANGER = 'u-stranger'

describe.skipIf(!available)('row level security of the cloud tables', () => {
  beforeAll(async () => {
    await prepareTestDatabase('cloud_rls')
    await withSystemContext('test', async () => {
      for (const id of [OWNER, MEMBER, STRANGER]) await prisma.user.create({ data: { id, email: `${id}@test.local`, name: id, role: 'user' } })
      await prisma.company.create({ data: { id: 'company-owned', name: 'Possédée', slug: 'possedee', siren: '912345675' } })
      await prisma.company.create({ data: { id: 'company-other', name: 'Autre', slug: 'autre', siren: '912345683' } })
      await prisma.organization.create({ data: { id: 'org-owned', name: 'Possédée', slug: 'org-possedee', createdAt: new Date(), companyId: 'company-owned' } })
      for (const userId of [OWNER, MEMBER]) {
        await prisma.member.create({ data: { id: `m-${userId}`, userId, organizationId: 'org-owned', role: 'companyAdmin', createdAt: new Date() } })
      }
      await prisma.cloudBillingAccount.create({ data: { id: 'ba-owner', ownerUserId: OWNER, subscriptionStatus: 'active', planId: 'holding' } })
      await prisma.cloudBillingAccount.create({ data: { id: 'ba-stranger', ownerUserId: STRANGER } })
      await prisma.cloudCompanyOwnership.create({ data: { companyId: 'company-owned', billingAccountId: 'ba-owner' } })
      await prisma.cloudCompanyOwnership.create({ data: { companyId: 'company-other', billingAccountId: 'ba-stranger' } })
      await prisma.cloudTermsAcceptance.create({ data: { userId: OWNER, document: 'cgv', version: '1.0' } })
      await prisma.cloudStripeEvent.create({ data: { id: 'evt_TestKledg00000001', type: 'invoice.paid' } })
    })
  }, 120_000)

  afterAll(async () => {
    process.env.KLEDG_RLS = previous.rls
    if (previous.fallback !== undefined) process.env.KLEDG_RLS_TEST_CONTEXT = previous.fallback
    await prisma.$disconnect()
  })

  it('lets the owner and the members of its companies read a billing account, nobody else', async () => {
    const ids = (userId: string) => withUserContext(userId, () => prisma.cloudBillingAccount.findMany({ select: { id: true }, orderBy: { id: 'asc' } }))
    expect(await ids(OWNER)).toEqual([{ id: 'ba-owner' }])
    expect(await ids(MEMBER)).toEqual([{ id: 'ba-owner' }])
    expect(await ids(STRANGER)).toEqual([{ id: 'ba-stranger' }])
  })

  it('lets only the owner write its billing account', async () => {
    const update = (userId: string) =>
      withUserContext(userId, () => prisma.cloudBillingAccount.updateMany({ where: { id: 'ba-owner' }, data: { planId: 'cabinet' } }))
    expect((await update(MEMBER)).count).toBe(0)
    expect((await update(STRANGER)).count).toBe(0)
    await expect(withUserContext(MEMBER, () => prisma.cloudBillingAccount.create({ data: { ownerUserId: OWNER } }))).rejects.toThrow()
    expect((await update(OWNER)).count).toBe(1)
  })

  it('follows the companies for ownership rows, and keeps acceptances to their user', async () => {
    expect(await withUserContext(STRANGER, () => prisma.cloudCompanyOwnership.findMany({ select: { companyId: true } }))).toEqual([])
    expect(await withUserContext(MEMBER, () => prisma.cloudCompanyOwnership.findMany({ select: { companyId: true } }))).toEqual([{ companyId: 'company-owned' }])
    await expect(
      withUserContext(OWNER, () => prisma.cloudCompanyOwnership.create({ data: { companyId: 'company-other', billingAccountId: 'ba-owner' } })),
    ).rejects.toThrow()
    expect(await withUserContext(MEMBER, () => prisma.cloudTermsAcceptance.count())).toBe(0)
    expect(await withUserContext(OWNER, () => prisma.cloudTermsAcceptance.count())).toBe(1)
  })

  it('keeps Stripe event ids to unrestricted contexts', async () => {
    expect(await withUserContext(OWNER, () => prisma.cloudStripeEvent.count())).toBe(0)
    expect(await withSystemContext('test', () => prisma.cloudStripeEvent.count())).toBe(1)
  })

  it('reads nothing and writes nothing without a context', async () => {
    expect(await prisma.cloudBillingAccount.count()).toBe(0)
    await expect(prisma.cloudStripeEvent.create({ data: { id: 'evt_TestKledg00000002', type: 'x' } })).rejects.toThrow()
  })
})

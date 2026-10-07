/**
 * Row level security of the Kledg Cloud tables (migration
 * 20261021090000_cloud_billing, docs/rls.md, docs/cloud.md), always under
 * KLEDG_RLS=enforce with the application role:
 * - a billing account is read by its owner and by the members of the
 *   companies it owns (the read-only check runs for them), written by its
 *   owner only, and never on its billing state (plan, status, dates: Stripe
 *   and the operator only, KLEDG-R3-CLOUD-04); another user sees nothing;
 * - ownership rows are read for reachable companies, written by
 *   unrestricted contexts only (KLEDG-R3-CLOUD-04);
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
      withUserContext(userId, () => prisma.cloudBillingAccount.updateMany({ where: { id: 'ba-owner' }, data: { deletionReason: 'requested', deletionRequestedAt: new Date(), deletionScheduledFor: new Date() } }))
    expect((await update(MEMBER)).count).toBe(0)
    expect((await update(STRANGER)).count).toBe(0)
    await expect(withUserContext(MEMBER, () => prisma.cloudBillingAccount.create({ data: { ownerUserId: OWNER } }))).rejects.toThrow()
    // The owner requests its deletion, then cancels it.
    expect((await update(OWNER)).count).toBe(1)
    const cancel = await withUserContext(OWNER, () =>
      prisma.cloudBillingAccount.updateMany({ where: { id: 'ba-owner' }, data: { deletionReason: null, deletionRequestedAt: null, deletionScheduledFor: null } }),
    )
    expect(cancel.count).toBe(1)
  })

  it('[KLEDG-R3-CLOUD-04] never lets the owner write its billing state: plan, status, trial, end of contract', async () => {
    const write = (data: Record<string, unknown>) =>
      withUserContext(OWNER, () => prisma.cloudBillingAccount.updateMany({ where: { id: 'ba-owner' }, data }))
    for (const data of [
      { planId: 'cabinet' },
      { subscriptionStatus: 'trialing' },
      { trialEnd: new Date('2099-01-01T00:00:00Z') },
      { stripeSubscriptionId: 'sub_TestOwn0000001' },
      { paymentFailedAt: null, currentPeriodEnd: new Date('2099-01-01T00:00:00Z') },
      { extraCompanies: 0, dedicatedDatabase: true },
    ]) {
      await expect(write(data), JSON.stringify(data)).rejects.toThrow()
    }
    // The Stripe customer is set once (Checkout), never replaced.
    expect((await write({ stripeCustomerId: 'cus_TestOwn000001' })).count).toBe(1)
    await expect(write({ stripeCustomerId: 'cus_TestOther0001' })).rejects.toThrow()
    // A deletion scheduled at the end of the contract is not the owner's to lift.
    await withSystemContext('test', () =>
      prisma.cloudBillingAccount.update({ where: { id: 'ba-stranger' }, data: { deletionReason: 'contract_ended', deletionScheduledFor: new Date('2026-12-01T00:00:00Z') } }),
    )
    await expect(
      withUserContext(STRANGER, () =>
        prisma.cloudBillingAccount.updateMany({ where: { id: 'ba-stranger' }, data: { deletionReason: null, deletionScheduledFor: null } }),
      ),
    ).rejects.toThrow()
    // A new account starts bare: no plan, no status.
    await withSystemContext('test', () => prisma.cloudBillingAccount.delete({ where: { id: 'ba-stranger' } }).then(() => undefined))
    await expect(
      withUserContext(STRANGER, () => prisma.cloudBillingAccount.create({ data: { ownerUserId: STRANGER, subscriptionStatus: 'active', planId: 'cabinet' } })),
    ).rejects.toThrow()
    await withUserContext(STRANGER, () => prisma.cloudBillingAccount.create({ data: { id: 'ba-stranger', ownerUserId: STRANGER } }))
    const owner = await withSystemContext('test', () => prisma.cloudBillingAccount.findUniqueOrThrow({ where: { id: 'ba-owner' } }))
    expect(owner).toMatchObject({ planId: 'holding', subscriptionStatus: 'active', trialEnd: null, stripeSubscriptionId: null })
  })

  it('[KLEDG-R3-CLOUD-04] never lets a member, nor the owner, delete or re-point an ownership row', async () => {
    // The policies hide the row from these statements: nothing is deleted or changed.
    for (const userId of [MEMBER, OWNER]) {
      expect((await withUserContext(userId, () => prisma.cloudCompanyOwnership.deleteMany({ where: { companyId: 'company-owned' } }))).count).toBe(0)
      const repointed = await withUserContext(userId, () =>
        prisma.cloudCompanyOwnership.updateMany({ where: { companyId: 'company-owned' }, data: { billingAccountId: 'ba-stranger' } }),
      )
      expect(repointed.count).toBe(0)
    }
    const row = await withSystemContext('test', () => prisma.cloudCompanyOwnership.findUniqueOrThrow({ where: { companyId: 'company-owned' } }))
    expect(row.billingAccountId).toBe('ba-owner')
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

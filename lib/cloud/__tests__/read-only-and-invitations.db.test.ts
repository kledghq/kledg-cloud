/**
 * Two Kledg features through the hosted service's policy (lib/cloud/enforcement.ts),
 * against PostgreSQL:
 * - bank sync of read-only companies (Kledg issue #15, lib/banking/sync-pause.ts):
 *   a company of an account read-only after a failed payment is paused with
 *   the billing reason and the link to the billing page; once paid, the
 *   sync resumes;
 * - invitations by company administrators (Kledg issue #13,
 *   lib/rbac/company-invitations.service.ts): allowed on the hosted service,
 *   an invitee without an account creates it from the link; a read-only
 *   company neither sends nor accepts.
 *
 * Both modules come from Kledg: until Kledg's change is merged into this
 * fork the file is skipped (loaded by path, so the branch still compiles).
 * Skipped when the test database server is unreachable.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

await vi.hoisted(async () => {
  const { useTestDatabase } = await import('@/lib/__tests__/helpers/test-db')
  useTestDatabase('cloud_readonly_invites')
  process.env.KLEDG_CLOUD_MODE = 'true'
  process.env.BETTER_AUTH_SECRET ??= 'kledg-test-secret-0123456789abcdef0123456789'
  process.env.BETTER_AUTH_URL ??= 'http://localhost:3000'
  process.env.RATE_LIMIT_DISABLED = 'true'
})

vi.mock('@/lib/email', () => ({ sendEmail: vi.fn(async () => undefined), isEmailEnabled: async () => false }))

import { prepareTestDatabase, testDatabaseAvailable } from '@/lib/__tests__/helpers/test-db'

const ROOT = path.resolve(__dirname, '../../..')
const merged = existsSync(path.join(ROOT, 'lib/banking/sync-pause.ts')) && existsSync(path.join(ROOT, 'lib/rbac/company-invitations.service.ts'))
const available = merged && (await testDatabaseAvailable())

/** Kledg modules loaded by path: absent before Kledg's change is merged. */
const load = <T,>(module: string): Promise<T> => import(/* @vite-ignore */ path.join(ROOT, module))

type SyncPause = { bankSyncPause: (companyId: string) => Promise<{ reason: string; link?: { label: string; href: string } } | null> }
type Invitations = {
  inviteMember: (input: Record<string, unknown>) => Promise<{ link?: string }>
  acceptInvitation: (token: string, acceptor: Record<string, unknown>) => Promise<{ createdUser: boolean; userId: string }>
}

const OWNER = { id: 'u-owner', email: 'owner@test.local', name: 'Claire', role: 'user' }
const DAY = 86_400_000

describe.skipIf(!available)('read-only companies and invitations on the hosted service', () => {
  let prisma: typeof import('@/lib/prisma').prisma
  let withSystemContext: typeof import('@/lib/rls/context').withSystemContext
  let withUserContext: typeof import('@/lib/rls/context').withUserContext
  let pause: SyncPause
  let invitations: Invitations
  let companyId: string

  beforeAll(async () => {
    await prepareTestDatabase('cloud_readonly_invites')
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ withSystemContext, withUserContext } = await import('@/lib/rls/context'))
    pause = await load<SyncPause>('lib/banking/sync-pause.ts')
    invitations = await load<Invitations>('lib/rbac/company-invitations.service.ts')
  }, 120_000)

  beforeEach(async () => {
    await prepareTestDatabase('cloud_readonly_invites')
    await prisma.user.create({ data: { ...OWNER, emailVerified: true } })
    const company = await prisma.company.create({ data: { name: 'Atelier Cloud', slug: 'atelier-cloud-x1', siren: '912345600' } })
    companyId = company.id
    await prisma.organization.create({ data: { id: 'org-cloud', name: company.name, slug: 'org-cloud', companyId, createdAt: new Date() } })
    await prisma.member.create({ data: { id: 'm-owner', userId: OWNER.id, organizationId: 'org-cloud', role: 'companyAdmin', createdAt: new Date() } })
    await prisma.cloudBillingAccount.create({
      data: { id: 'ba-owner', ownerUserId: OWNER.id, stripeCustomerId: 'cus_TestReadOnly01', stripeSubscriptionId: 'sub_TestReadOnly01', subscriptionStatus: 'active', planId: 'holding', currentPeriodEnd: new Date(Date.now() + 20 * DAY), trialUsed: true },
    })
    await prisma.cloudCompanyOwnership.create({ data: { companyId, billingAccountId: 'ba-owner' } })
  })

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  const failPayment = () =>
    prisma.cloudBillingAccount.update({ where: { id: 'ba-owner' }, data: { subscriptionStatus: 'past_due', paymentFailedAt: new Date(Date.now() - 20 * DAY) } })
  const pay = () => prisma.cloudBillingAccount.update({ where: { id: 'ba-owner' }, data: { subscriptionStatus: 'active', paymentFailedAt: null } })
  /** As the route runs it: in the inviter's context. */
  const invite = (email: string, role: string) =>
    withUserContext(OWNER.id, () => invitations.inviteMember({ companyId, email, role, inviter: OWNER, inviterCan: () => true }))
  const pauseOf = () => withSystemContext('test', () => pause.bankSyncPause(companyId), { companyIds: [companyId] })

  it('pauses the bank sync of a company whose account is read-only, with the reason and the billing link, and resumes once paid (issue #15)', async () => {
    expect(await pauseOf()).toBeNull()
    await failPayment()
    const paused = await pauseOf()
    expect(paused?.reason).toContain('le paiement de l')
    expect(paused?.link?.href).toBeTruthy()
    await pay()
    expect(await pauseOf()).toBeNull()
  })

  it('lets a company administrator invite, and the invitee create their account from the link (issue #13)', async () => {
    const sent = await invite('expert@cabinet.fr', 'accountant')
    const token = sent.link?.split('/invitation/')[1]
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const accepted = await invitations.acceptInvitation(token!, { newAccount: { name: 'Eva Expert', password: 'motdepasse-solide-42' } })
    expect(accepted.createdUser).toBe(true)
    expect(await prisma.user.findUniqueOrThrow({ where: { id: accepted.userId } })).toMatchObject({ emailVerified: true })
    expect((await prisma.member.findFirstOrThrow({ where: { userId: accepted.userId } })).role).toBe('accountant')
  })

  it('a company of a read-only account neither sends nor accepts invitations (issue #13)', async () => {
    const sent = await invite('expert@cabinet.fr', 'viewer')
    const token = sent.link!.split('/invitation/')[1]
    await failPayment()
    await expect(invite('other@cabinet.fr', 'viewer')).rejects.toThrow(/lecture seule/)
    await expect(invitations.acceptInvitation(token, { newAccount: { name: 'E', password: 'motdepasse-solide-42' } })).rejects.toThrow(/lecture seule/)
    expect(await prisma.user.count({ where: { email: 'expert@cabinet.fr' } })).toBe(0)
  })
})

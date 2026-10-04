/**
 * Attack tests of the Kledg Cloud layer (pentest round 2, findings
 * KLEDG-CLOUD-*, registry in lib/__tests__/security/findings.ts), against
 * PostgreSQL, Stripe mocked, through Kledg's own routes:
 * - KLEDG-CLOUD-001: a plan switch to a smaller plan (Customer Portal, or a
 *   new subscription after a trial or an ended contract) must not leave the
 *   companies beyond the new limit writable;
 * - KLEDG-CLOUD-002: concurrent company creations must not end with more
 *   writable companies than the plan allows;
 * - KLEDG-CLOUD-003: a Cabinet trial (no card) must not create companies
 *   without bound;
 * - KLEDG-CLOUD-004 (open, fix in Kledg core): a member added to a company
 *   by the operator must not inherit the password of an unconfirmed account
 *   someone else created with that address through the public sign-up.
 *
 * Skipped when the test database server is unreachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = await vi.hoisted(async () => {
  const { useTestDatabase } = await import('@/lib/__tests__/helpers/test-db')
  useTestDatabase('cloud_security')
  process.env.BETTER_AUTH_SECRET ??= 'kledg-test-secret-0123456789abcdef0123456789'
  process.env.BETTER_AUTH_URL ??= 'http://localhost:3000'
  process.env.RATE_LIMIT_DISABLED = 'true'
  return { user: null as null | { id: string; email: string; name: string | null; role: string | null } }
})

vi.mock('@/lib/session', () => ({ getCurrentUser: async () => state.user }))

import { prepareTestDatabase, testDatabaseAvailable } from '@/lib/__tests__/helpers/test-db'
import { seedMembership } from '@/lib/__tests__/helpers/membership'
import { skip } from '@/lib/__tests__/security/findings'
import type { CreateCompanyInput } from '@/lib/companies/company-wizard'

const available = await testDatabaseAvailable()

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>
let prisma: typeof import('@/lib/prisma').prisma
const routes = {} as Record<'companies' | 'company', Record<string, Handler>>

const USERS = {
  owner: { id: 'u-owner', email: 'owner@test.local', name: 'Claire', role: 'user' },
  member: { id: 'u-member', email: 'member@test.local', name: 'Comptable', role: 'user' },
  racer: { id: 'u-racer', email: 'racer@test.local', name: 'Rapide', role: 'user' },
  trial: { id: 'u-trial', email: 'trial@test.local', name: 'Essai', role: 'user' },
} as const
type Who = keyof typeof USERS

// Luhn-valid SIRENs.
const SIRENS = ['912345600', '912345618', '912345626', '912345634', '912345642', '912345659', '912345667', '912345675']
let next = 0
const company = (name: string): CreateCompanyInput => ({
  name,
  siren: SIRENS[next++],
  legalType: 'SASU',
  firstFiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31', isFirst: false },
  vatRegime: 'simplified',
  corporateTaxRegime: 'simplified',
})

async function create(who: Who, name: string) {
  state.user = { ...USERS[who] }
  return routes.companies.POST(
    new NextRequest('http://localhost/api/companies', { method: 'POST', body: JSON.stringify(company(name)), headers: { 'content-type': 'application/json' } }),
  )
}

async function companyCall(who: Who, method: 'GET' | 'PATCH', id: string, body?: unknown) {
  state.user = { ...USERS[who] }
  return routes.company[method](
    new NextRequest(`http://localhost/api/companies/${id}`, {
      method,
      ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    }),
    { params: Promise.resolve({ id }) },
  )
}

const json = async (response: Response) => (await response.json()) as Record<string, unknown> & { id: string; error: string }
const DAY = 86_400_000

/** Ids of the companies `who` owns, in the order they were created. */
async function ownedIds(who: Who): Promise<string[]> {
  const account = await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { ownerUserId: USERS[who].id } })
  const rows = await prisma.cloudCompanyOwnership.findMany({ where: { billingAccountId: account.id }, orderBy: [{ createdAt: 'asc' }, { companyId: 'asc' }] })
  return rows.map((row) => row.companyId)
}

describe.skipIf(!available)('Kledg Cloud attack tests', () => {
  beforeAll(async () => {
    await prepareTestDatabase('cloud_security')
    ;({ prisma } = await import('@/lib/prisma'))
    routes.companies = (await import('@/app/api/companies/route')) as unknown as Record<string, Handler>
    routes.company = (await import('@/app/api/companies/[id]/route')) as unknown as Record<string, Handler>
    for (const user of Object.values(USERS)) {
      await prisma.user.create({ data: { id: user.id, email: user.email, name: user.name, role: user.role, emailVerified: true } })
    }
  }, 120_000)

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  beforeEach(() => {
    vi.stubEnv('KLEDG_CLOUD_MODE', 'true')
  })

  it('[KLEDG-CLOUD-001] fixed: companies beyond the limit of a smaller plan are read-only, the oldest ones stay writable', async () => {
    await prisma.cloudBillingAccount.create({ data: { ownerUserId: 'u-owner', subscriptionStatus: 'active', planId: 'holding', billingInterval: 'month' } })
    for (const name of ['Holding Mère', 'Filiale Une', 'Filiale Deux']) expect((await create('owner', name)).status).toBe(201)
    const [first, second, third] = await ownedIds('owner')
    // An accountant the operator added to the third company.
    const org = await prisma.organization.findUniqueOrThrow({ where: { companyId: third } })
    await prisma.member.create({ data: { id: 'm-member-third', userId: 'u-member', organizationId: org.id, role: 'companyAdmin', createdAt: new Date() } })

    // Switch to Essentiel in the Customer Portal: the webhook mirrors the new plan.
    await prisma.cloudBillingAccount.update({ where: { ownerUserId: 'u-owner' }, data: { planId: 'essentiel' } })

    expect((await companyCall('owner', 'PATCH', first, { phone: '0102030405' })).status).toBe(200)
    for (const id of [second, third]) {
      const refused = await companyCall('owner', 'PATCH', id, { phone: '0102030405' })
      expect(refused.status).toBe(409)
      expect(await json(refused)).toEqual({
        error:
          "Cette société est en lecture seule\u00a0: l'offre Essentiel de son titulaire couvre 1 société et son compte en possède davantage. Ses données restent consultables et exportables (FEC, export complet). Le titulaire du compte peut passer à une offre plus large depuis sa page Facturation.",
        link: { label: 'Voir les offres', href: '/settings/billing' },
      })
      expect((await companyCall('owner', 'GET', id)).status).toBe(200)
    }
    // Every member is bound by the owner's plan, not only the owner.
    expect((await companyCall('member', 'PATCH', third, { phone: '0102030405' })).status).toBe(409)

    // An archived company frees its slot (the operator archives on request).
    await prisma.company.update({ where: { id: first }, data: { archivedAt: new Date() } })
    expect((await companyCall('owner', 'PATCH', second, { phone: '0102030405' })).status).toBe(200)
    expect((await companyCall('owner', 'PATCH', third, { phone: '0102030405' })).status).toBe(409)
    await prisma.company.update({ where: { id: first }, data: { archivedAt: null } })

    // Back to Holding: everything is writable again.
    await prisma.cloudBillingAccount.update({ where: { ownerUserId: 'u-owner' }, data: { planId: 'holding' } })
    for (const id of [first, second, third]) expect((await companyCall('owner', 'PATCH', id, { phone: '0102030405' })).status).toBe(200)
    expect((await companyCall('member', 'PATCH', third, { phone: '0102030405' })).status).toBe(200)
  })

  it('[KLEDG-CLOUD-002] fixed: concurrent creations never leave more writable companies than the plan allows', async () => {
    await prisma.cloudBillingAccount.create({
      data: { ownerUserId: 'u-racer', subscriptionStatus: 'trialing', planId: 'essentiel', trialEnd: new Date(Date.now() + 20 * DAY), trialUsed: true },
    })
    const responses = await Promise.all([create('racer', 'Course A'), create('racer', 'Course B'), create('racer', 'Course C')])
    const created = await Promise.all(responses.filter((r) => r.status === 201).map(async (r) => (await json(r)).id))
    expect(created.length).toBeGreaterThanOrEqual(1)
    let writable = 0
    for (const id of created) {
      if ((await companyCall('racer', 'PATCH', id, { phone: '0102030405' })).status === 200) writable += 1
    }
    expect(writable).toBe(1)
  })

  it('[KLEDG-CLOUD-003] fixed: a Cabinet trial creates at most the 25 included companies', async () => {
    const account = await prisma.cloudBillingAccount.create({
      data: {
        ownerUserId: 'u-trial',
        subscriptionStatus: 'trialing',
        planId: 'cabinet',
        billingInterval: 'month',
        trialEnd: new Date(Date.now() + 20 * DAY),
        trialUsed: true,
      },
    })
    for (let i = 0; i < 25; i++) {
      const c = await prisma.company.create({ data: { name: `Essai ${i}`, slug: `essai-${i}`, siren: String(300000000 + i) } })
      await seedMembership(prisma, 'u-trial', c.id, 'companyAdmin')
      await prisma.cloudCompanyOwnership.create({ data: { companyId: c.id, billingAccountId: account.id } })
    }
    const refused = await create('trial', 'Vingt-sixième sans carte')
    expect(refused.status).toBe(403)
    expect((await json(refused)).error).toBe(
      "Votre essai de l'offre Cabinet permet 25 sociétés\u00a0: vous en avez déjà 25. Les sociétés suivantes, facturées à l'unité, se créent une fois l'abonnement payé, à la fin de l'essai.",
    )
    // Once the subscription is paid, Cabinet has no hard limit again (companies beyond 25 are billed).
    const { cloudCompanyCreationRefusal } = await import('@/lib/cloud/enforcement')
    await prisma.cloudBillingAccount.update({ where: { id: account.id }, data: { subscriptionStatus: 'active' } })
    expect(await cloudCompanyCreationRefusal({ id: 'u-trial', email: USERS.trial.email, role: 'user' })).toBeNull()
  })

  it.skip(skip('KLEDG-CLOUD-004', 'adding an existing unconfirmed account as a member keeps the password its creator chose'), async () => {
    const { auth } = await import('@/lib/auth')
    const { addMemberToCompany } = await import('@/lib/rbac/add-member-to-company.service')
    // The attacker signs up first with the address of the accountant the customer will ask for (public sign-up, never confirmed).
    await auth.api.createUser({ body: { email: 'expert@cabinet.test', password: 'attacker-chosen-password', name: 'Expert', role: 'user' } })
    const victim = await prisma.user.findUniqueOrThrow({ where: { email: 'expert@cabinet.test' } })
    const before = await prisma.authAccount.findFirstOrThrow({ where: { userId: victim.id, providerId: 'credential' } })
    const [target] = await ownedIds('owner')

    // The operator adds the accountant to the customer's company (Membres page).
    const result = await addMemberToCompany({ companyId: target, email: 'expert@cabinet.test', role: 'accountant' })
    expect(result.createdUser).toBe(false)

    // Expected: the credential chosen before the address was proven is gone (a welcome link sets a new one).
    const after = await prisma.authAccount.findFirst({ where: { userId: victim.id, providerId: 'credential' } })
    expect(after?.password ?? null).not.toBe(before.password)
  })
})

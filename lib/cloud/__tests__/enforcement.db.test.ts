/**
 * Plan limits and read-only accounts of Kledg Cloud through Kledg's own
 * routes and the instance policy (lib/cloud/enforcement.ts), against
 * PostgreSQL, Stripe mocked:
 * - without a subscription a user creates nothing and is sent to the plans
 *   (the trial starts at Checkout);
 * - in trial or subscribed, companies within the plan: the creator owns
 *   them and administers them; one more is refused in French with a link;
 *   archived companies do not count; Cabinet bills each company beyond 25;
 * - a read-only account (14 days after a failed payment, contract ended,
 *   deletion requested) creates nothing and its companies refuse every
 *   write (409) for every member, while reads keep working;
 * - the operator and the companies it created are never restricted;
 * - outside cloud mode everything is Kledg's own behaviour.
 *
 * Skipped when the test database server is unreachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = await vi.hoisted(async () => {
  const { useTestDatabase } = await import('@/lib/__tests__/helpers/test-db')
  useTestDatabase('cloud_enforcement')
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
import type { CreateCompanyInput } from '@/lib/companies/company-wizard'
import { clearPriceCache } from '@/lib/cloud/billing/stripe-prices'
import { form, pricesList, stripeFetch, subscriptionObject } from './helpers/stripe-fixtures'

const available = await testDatabaseAvailable()

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>
let prisma: typeof import('@/lib/prisma').prisma
const routes = {} as Record<'companies' | 'company', Record<string, Handler>>
let assertCompanyWritable: typeof import('@/lib/companies/archive-company.service').assertCompanyWritable

const USERS = {
  admin: { id: 'u-admin', email: 'admin@test.local', name: 'Opérateur', role: 'admin' },
  owner: { id: 'u-owner', email: 'owner@test.local', name: 'Claire', role: 'user' },
  member: { id: 'u-member', email: 'member@test.local', name: 'Comptable', role: 'user' },
  cabinet: { id: 'u-cabinet', email: 'cabinet@test.local', name: 'Cabinet', role: 'user' },
} as const
type Who = keyof typeof USERS

// Luhn-valid SIRENs (912345600 + 8k + ...).
const SIRENS = ['912345600', '912345618', '912345626', '912345634', '912345642', '912345659', '912345667', '912345675', '912345683', '912345691', '912345709', '912345717']
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
const setOwner = (data: Record<string, unknown>) => prisma.cloudBillingAccount.update({ where: { ownerUserId: 'u-owner' }, data })

describe.skipIf(!available)('Kledg Cloud enforcement', () => {
  beforeAll(async () => {
    await prepareTestDatabase('cloud_enforcement')
    ;({ prisma } = await import('@/lib/prisma'))
    routes.companies = (await import('@/app/api/companies/route')) as unknown as Record<string, Handler>
    routes.company = (await import('@/app/api/companies/[id]/route')) as unknown as Record<string, Handler>
    ;({ assertCompanyWritable } = await import('@/lib/companies/archive-company.service'))
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

  it('outside cloud mode, keeps company creation to the instance administrators', async () => {
    vi.stubEnv('KLEDG_CLOUD_MODE', '')
    const response = await create('owner', 'Refusée hors cloud')
    expect(response.status).toBe(403)
    expect((await json(response)).error).toBe("La création de sociétés est réservée aux administrateurs de l'instance.")
  })

  it('sends a user without a subscription to the plans: the trial starts at Checkout', async () => {
    const response = await create('owner', 'Sans offre')
    expect(response.status).toBe(403)
    expect(await json(response)).toEqual({
      error:
        "Choisissez une offre pour créer votre première société : l'essai gratuit de 30 jours démarre sans carte bancaire et ne se transforme pas en abonnement payant sans votre accord.",
      link: { label: 'Choisir une offre', href: '/settings/billing' },
    })
    expect(await prisma.cloudBillingAccount.count()).toBe(0)
  })

  it('lets a user in trial create companies within the plan tried: they own and administer them', async () => {
    await prisma.cloudBillingAccount.create({
      data: { ownerUserId: 'u-owner', subscriptionStatus: 'trialing', planId: 'essentiel', trialEnd: new Date(Date.now() + 20 * DAY), trialUsed: true },
    })
    const first = await create('owner', 'Atelier Lumen')
    expect(first.status).toBe(201)
    const { id } = await json(first)
    const account = await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { ownerUserId: 'u-owner' }, include: { companies: true } })
    expect(account.companies.map((c) => c.companyId)).toEqual([id])
    expect(await prisma.member.findMany({ where: { organization: { companyId: id } }, select: { userId: true, role: true } })).toEqual([
      { userId: 'u-owner', role: 'companyAdmin' },
    ])

    const refused = await create('owner', 'Deuxième')
    expect(refused.status).toBe(403)
    expect(await json(refused)).toEqual({
      error: "Votre essai de l'offre Essentiel permet 1 société : vous en avez déjà 1. Passez à une offre plus large pour créer une nouvelle société.",
      link: { label: 'Voir les offres', href: '/settings/billing' },
    })
  })

  it('counts companies against the paid plan, archived ones excepted', async () => {
    await setOwner({ subscriptionStatus: 'active', planId: 'holding' })
    expect((await create('owner', 'Filiale')).status).toBe(201)
    const { countedCompanies } = await import('../billing/billing-account.service')
    const account = await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { ownerUserId: 'u-owner' } })
    expect(await countedCompanies(account.id)).toBe(2)
    await setOwner({ planId: 'essentiel' })
    expect((await create('owner', 'Au-delà')).status).toBe(403)
    const owned = await prisma.cloudCompanyOwnership.findMany({ where: { billingAccountId: account.id } })
    await prisma.company.update({ where: { id: owned[1].companyId }, data: { archivedAt: new Date() } })
    expect(await countedCompanies(account.id)).toBe(1)
    await prisma.company.update({ where: { id: owned[1].companyId }, data: { archivedAt: null } })
    await setOwner({ planId: 'holding' })
  })

  it('bills each Cabinet company beyond the 25 included on the subscription', async () => {
    const account = await prisma.cloudBillingAccount.create({
      data: { ownerUserId: 'u-cabinet', subscriptionStatus: 'active', planId: 'cabinet', billingInterval: 'month', stripeSubscriptionId: 'sub_TestCabinet01' },
    })
    for (let i = 0; i < 25; i++) {
      const c = await prisma.company.create({ data: { name: `Client ${i}`, slug: `client-${i}`, siren: String(200000000 + i) } })
      await prisma.cloudCompanyOwnership.create({ data: { companyId: c.id, billingAccountId: account.id } })
    }
    clearPriceCache()
    const api = stripeFetch({
      'GET /v1/subscriptions/sub_TestCabinet01': subscriptionObject({ id: 'sub_TestCabinet01', customer: 'cus_TestCabinet01', status: 'active', plan: 'cabinet' }),
      'GET /v1/prices': pricesList(),
      'POST /v1/subscription_items': { id: 'si_TestExtra0001', object: 'subscription_item', quantity: 1 },
    })
    state.stripe = api.stripe
    const created = await create('cabinet', 'Vingt-sixième')
    expect(created.status).toBe(201)
    const added = api.calls.find((c) => c.path === '/v1/subscription_items')
    expect(form(added?.body ?? '')).toEqual({
      subscription: 'sub_TestCabinet01',
      price: 'price_TestCabinetExtraCompanyMonth',
      quantity: '1',
      proration_behavior: 'create_prorations',
    })
    expect((await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { id: account.id } })).extraCompanies).toBe(1)
  })

  describe('read-only account', () => {
    let ownedId: string

    beforeAll(async () => {
      const account = await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { ownerUserId: 'u-owner' } })
      ownedId = (await prisma.cloudCompanyOwnership.findFirstOrThrow({ where: { billingAccountId: account.id } })).companyId
      const org = await prisma.organization.findUniqueOrThrow({ where: { companyId: ownedId } })
      await prisma.member.create({ data: { id: 'm-member', userId: 'u-member', organizationId: org.id, role: 'companyAdmin', createdAt: new Date() } })
    })

    it('stays writable during the 14 days after a failed payment', async () => {
      await setOwner({ subscriptionStatus: 'past_due', paymentFailedAt: new Date(Date.now() - 13 * DAY) })
      expect((await companyCall('owner', 'PATCH', ownedId, { phone: '0102030405' })).status).toBe(200)
    })

    it('then refuses writes for every member, keeps reads, and refuses new companies', async () => {
      await setOwner({ subscriptionStatus: 'past_due', paymentFailedAt: new Date(Date.now() - 15 * DAY) })
      for (const who of ['owner', 'member'] as const) {
        const write = await companyCall(who, 'PATCH', ownedId, { phone: '0999999999' })
        expect(write.status).toBe(409)
        expect(await json(write)).toEqual({
          error:
            "Cette société est en lecture seule : le paiement de l'abonnement de son titulaire a échoué. Ses données restent consultables et exportables (FEC, export complet). Le titulaire du compte peut rétablir l'accès depuis sa page Facturation.",
          link: { label: 'Voir les offres', href: '/settings/billing' },
        })
      }
      const read = await companyCall('member', 'GET', ownedId)
      expect(read.status).toBe(200)
      expect((await json(read)).phone).toBe('0102030405')
      // MCP tools check writes through the same function.
      await expect(assertCompanyWritable(ownedId)).rejects.toMatchObject({ statusCode: 409 })
      const refused = await create('owner', 'Nouvelle')
      expect(refused.status).toBe(403)
      expect((await json(refused)).error).toMatch(/^Votre compte est en lecture seule : le paiement de votre abonnement a échoué\./)
    })

    it('is read-only after the end of the contract and while a deletion waits, writable again once subscribed', async () => {
      await setOwner({ subscriptionStatus: 'canceled', paymentFailedAt: null, subscriptionEndedAt: new Date(Date.now() - 2 * DAY) })
      expect((await companyCall('owner', 'PATCH', ownedId, { phone: '0111111111' })).status).toBe(409)
      expect((await companyCall('owner', 'GET', ownedId)).status).toBe(200)
      await setOwner({ subscriptionStatus: 'active', deletionScheduledFor: new Date(Date.now() + 20 * DAY), deletionReason: 'requested' })
      expect((await companyCall('owner', 'PATCH', ownedId, { phone: '0111111111' })).status).toBe(409)
      await setOwner({ deletionScheduledFor: null, deletionReason: null })
      expect((await companyCall('owner', 'PATCH', ownedId, { phone: '0111111111' })).status).toBe(200)
    })
  })

  it('never restricts the operator, nor the companies it created (they belong to no account)', async () => {
    const created = await create('admin', 'Société de l’opérateur')
    expect(created.status).toBe(201)
    const { id } = await json(created)
    expect(await prisma.cloudCompanyOwnership.findUnique({ where: { companyId: id } })).toBeNull()
    expect(await prisma.cloudBillingAccount.findUnique({ where: { ownerUserId: 'u-admin' } })).toBeNull()
    expect((await companyCall('admin', 'PATCH', id, { phone: '0122334455' })).status).toBe(200)
  })
})

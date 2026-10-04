/**
 * Quota and read-only enforcement of Kledg Cloud through Kledg's own routes
 * and the instance policy (lib/cloud/enforcement.ts), against PostgreSQL:
 * - users create companies within their trial or plan; the creator owns
 *   them and becomes their administrator; one more is refused in French
 *   with a link to the plans; archived companies do not count;
 * - a read-only account (trial and grace over, payment failed past the
 *   grace) can create nothing and its companies refuse every write (409),
 *   for every member, while reads keep working;
 * - the operator (instance administrator) and the companies it created are
 *   never restricted;
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
  return { user: null as null | { id: string; email: string; name: string | null; role: string | null } }
})

vi.mock('@/lib/session', () => ({ getCurrentUser: async () => state.user }))

import { prepareTestDatabase, testDatabaseAvailable } from '@/lib/__tests__/helpers/test-db'
import type { CreateCompanyInput } from '@/lib/companies/company-wizard'

const available = await testDatabaseAvailable()

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>
let prisma: typeof import('@/lib/prisma').prisma
const routes = {} as Record<'companies' | 'company', Record<string, Handler>>
let assertCompanyWritable: typeof import('@/lib/companies/archive-company.service').assertCompanyWritable

const USERS = {
  admin: { id: 'u-admin', email: 'admin@test.local', name: 'Opérateur', role: 'admin' },
  owner: { id: 'u-owner', email: 'owner@test.local', name: 'Claire', role: 'user' },
  member: { id: 'u-member', email: 'member@test.local', name: 'Comptable', role: 'user' },
} as const
type Who = keyof typeof USERS

const SIRENS = ['912345600', '912345618', '912345626', '912345634', '912345642', '912345659', '912345667', '912345675', '912345683', '912345691']
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
    vi.stubEnv('KLEDG_CLOUD_TRIAL_COMPANIES', '2')
  })

  it('outside cloud mode, keeps company creation to the instance administrators', async () => {
    vi.stubEnv('KLEDG_CLOUD_MODE', '')
    const response = await create('owner', 'Refusée hors cloud')
    expect(response.status).toBe(403)
    expect((await json(response)).error).toBe("La création de sociétés est réservée aux administrateurs de l'instance.")
    expect(await prisma.cloudBillingAccount.count()).toBe(0)
  })

  it('lets a user create companies within the trial: they own them and administer them', async () => {
    const first = await create('owner', 'Atelier Lumen')
    expect(first.status).toBe(201)
    const { id } = await json(first)
    const account = await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { ownerUserId: 'u-owner' }, include: { companies: true } })
    expect(account.companies.map((c) => c.companyId)).toEqual([id])
    // The trial started with the first company (30 days by default).
    expect(Math.round((account.trialEndsAt.getTime() - Date.now()) / DAY)).toBe(30)
    expect(await prisma.member.findMany({ where: { organization: { companyId: id } }, select: { userId: true, role: true } })).toEqual([
      { userId: 'u-owner', role: 'companyAdmin' },
    ])
    expect((await create('owner', 'Lumen Holding')).status).toBe(201)
  })

  it('refuses one company more than the trial allows, in French with a link to the plans', async () => {
    const refused = await create('owner', 'Troisième')
    expect(refused.status).toBe(403)
    expect(await json(refused)).toEqual({
      error: "Pendant l'essai gratuit, vous pouvez créer 2 sociétés : vous en avez déjà 2. Choisissez une offre plus large pour créer une nouvelle société.",
      link: { label: 'Voir les offres', href: '/settings/billing' },
    })
  })

  it('counts companies against the paid plan, archived ones excepted', async () => {
    await prisma.cloudBillingAccount.update({ where: { ownerUserId: 'u-owner' }, data: { subscriptionStatus: 'active', planId: 'essentiel' } })
    const refused = await create('owner', 'Au-delà de l’offre')
    expect((await json(refused)).error).toBe(
      'Votre offre Essentiel permet 1 société : vous en avez déjà 2. Choisissez une offre plus large pour créer une nouvelle société.',
    )
    await prisma.cloudBillingAccount.update({ where: { ownerUserId: 'u-owner' }, data: { planId: 'holding' } })
    expect((await create('owner', 'Filiale')).status).toBe(201)
    const owned = await prisma.cloudCompanyOwnership.findMany({ select: { companyId: true } })
    expect(owned).toHaveLength(3)
    // Archived companies (read-only, hidden) do not count: back on Essentiel, one archived leaves room for none, two for one.
    const { countedCompanies } = await import('../billing/billing-account.service')
    const accountId = (await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { ownerUserId: 'u-owner' } })).id
    expect(await countedCompanies(accountId)).toBe(3)
    await prisma.cloudBillingAccount.update({ where: { ownerUserId: 'u-owner' }, data: { planId: 'essentiel' } })
    const archive = (count: number) =>
      prisma.company.updateMany({ where: { id: { in: owned.slice(0, count).map((o) => o.companyId) } }, data: { archivedAt: new Date() } })
    await archive(2)
    expect(await countedCompanies(accountId)).toBe(1)
    expect((await create('owner', 'Toujours au-delà')).status).toBe(403)
    await prisma.company.updateMany({ where: { id: { in: owned.map((o) => o.companyId) } }, data: { archivedAt: null } })
    await prisma.cloudBillingAccount.update({ where: { ownerUserId: 'u-owner' }, data: { planId: 'holding' } })
  })

  describe('read-only account', () => {
    let ownedId: string

    beforeAll(async () => {
      ownedId = (await prisma.cloudCompanyOwnership.findFirstOrThrow({ select: { companyId: true } })).companyId
      const org = await prisma.organization.findUniqueOrThrow({ where: { companyId: ownedId } })
      await prisma.member.create({ data: { id: 'm-member', userId: 'u-member', organizationId: org.id, role: 'companyAdmin', createdAt: new Date() } })
    })

    it('stays writable during the grace after a failed payment', async () => {
      await prisma.cloudBillingAccount.update({
        where: { ownerUserId: 'u-owner' },
        data: { subscriptionStatus: 'past_due', paymentFailedAt: new Date(Date.now() - 3 * DAY) },
      })
      expect((await companyCall('owner', 'PATCH', ownedId, { phone: '0102030405' })).status).toBe(200)
    })

    it('refuses writes to its companies for every member, keeps reads, and refuses new companies', async () => {
      await prisma.cloudBillingAccount.update({
        where: { ownerUserId: 'u-owner' },
        data: { subscriptionStatus: 'past_due', paymentFailedAt: new Date(Date.now() - 15 * DAY) },
      })
      for (const who of ['owner', 'member'] as const) {
        const write = await companyCall(who, 'PATCH', ownedId, { phone: '0999999999' })
        expect(write.status).toBe(409)
        expect(await json(write)).toEqual({
          error:
            "Cette société est en lecture seule : le paiement de l'abonnement de son titulaire a échoué. Ses données restent consultables et exportables (FEC, export complet). Le titulaire du compte peut choisir une offre depuis sa page Facturation.",
          link: { label: 'Voir les offres', href: '/settings/billing' },
        })
      }
      const read = await companyCall('member', 'GET', ownedId)
      expect(read.status).toBe(200)
      expect((await json(read)).phone).toBe('0102030405')

      // The MCP tools check writes through the same function.
      await expect(assertCompanyWritable(ownedId)).rejects.toMatchObject({ statusCode: 409 })

      const refused = await create('owner', 'Nouvelle')
      expect(refused.status).toBe(403)
      expect((await json(refused)).error).toBe(
        'Votre compte est en lecture seule : le paiement de votre abonnement a échoué. Choisissez une offre pour créer des sociétés et reprendre la saisie. Vos données restent consultables et exportables.',
      )
    })

    it('turns read-only after the trial and its grace, writable again once subscribed', async () => {
      await prisma.cloudBillingAccount.update({
        where: { ownerUserId: 'u-owner' },
        data: { subscriptionStatus: null, paymentFailedAt: null, planId: null, trialEndsAt: new Date(Date.now() - 20 * DAY) },
      })
      expect((await companyCall('owner', 'PATCH', ownedId, { phone: '0111111111' })).status).toBe(409)
      await prisma.cloudBillingAccount.update({ where: { ownerUserId: 'u-owner' }, data: { subscriptionStatus: 'active', planId: 'holding' } })
      expect((await companyCall('owner', 'PATCH', ownedId, { phone: '0111111111' })).status).toBe(200)
    })
  })

  it('never restricts the operator, nor the companies it created (they belong to no account)', async () => {
    await prisma.cloudBillingAccount.update({ where: { ownerUserId: 'u-owner' }, data: { subscriptionStatus: 'paused' } })
    const created = await create('admin', 'Société de l’opérateur')
    expect(created.status).toBe(201)
    const { id } = await json(created)
    expect(await prisma.cloudCompanyOwnership.findUnique({ where: { companyId: id } })).toBeNull()
    expect(await prisma.cloudBillingAccount.findUnique({ where: { ownerUserId: 'u-admin' } })).toBeNull()
    expect((await companyCall('admin', 'PATCH', id, { phone: '0122334455' })).status).toBe(200)
  })
})

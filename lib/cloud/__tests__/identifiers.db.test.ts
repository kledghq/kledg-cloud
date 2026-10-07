/**
 * Company identifiers in the shared database of Kledg Cloud (pentest round 3,
 * KLEDG-R3-CLOUD-01), against PostgreSQL through Kledg's own routes:
 * - a SIREN or a SIRET is unique within a customer's companies only: a free
 *   trial cannot take the SIREN of a business that is not a customer yet;
 * - no answer tells whether another customer uses a SIREN, a SIRET or a
 *   slug: the same status for "used by another customer" and "free", and
 *   slugs get a random suffix;
 * - within one customer's companies the SIREN and the SIRET stay unique.
 *
 * Run with KLEDG_RLS=enforce (docs/cloud.md). Skipped when the test
 * database server is unreachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = await vi.hoisted(async () => {
  const { useTestDatabase } = await import('@/lib/__tests__/helpers/test-db')
  useTestDatabase('cloud_identifiers')
  process.env.BETTER_AUTH_SECRET ??= 'kledg-test-secret-0123456789abcdef0123456789'
  process.env.BETTER_AUTH_URL ??= 'http://localhost:3000'
  process.env.RATE_LIMIT_DISABLED = 'true'
  return { user: null as null | { id: string; email: string; name: string | null; role: string | null } }
})

vi.mock('@/lib/session', () => ({ getCurrentUser: async () => state.user }))

import { prepareTestDatabase, testDatabaseAvailable } from '@/lib/__tests__/helpers/test-db'
import type { CreateCompanyInput } from '@/lib/companies/company-wizard'
import { rlsMode } from '@/lib/rls/mode'

const available = await testDatabaseAvailable()

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>
let prisma: typeof import('@/lib/prisma').prisma
let rls: typeof import('@/lib/rls/context')
const routes = {} as Record<'companies' | 'company' | 'establishments', Record<string, Handler>>

const USERS = {
  victim: { id: 'u-victim', email: 'victim@test.local', name: 'Victime', role: 'user' },
  squatter: { id: 'u-squatter', email: 'squatter@test.local', name: 'Squatteur', role: 'user' },
} as const
type Who = keyof typeof USERS

const DAY = 86_400_000
// Luhn-valid SIRENs and SIRETs.
const VICTIM_SIREN = '823456702'
const SQUATTER_OWN_SIREN = '823456710'
const OTHER_TENANT_SIREN = '823456728'
const FREE_SIREN = '823456736'
const SECOND_OWN_SIREN = '823456744'

const company = (name: string, siren: string): CreateCompanyInput => ({
  name,
  siren,
  legalType: 'SASU',
  firstFiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31', isFirst: false },
  vatRegime: 'simplified',
  corporateTaxRegime: 'simplified',
})

const jsonRequest = (url: string, method: string, body: unknown) =>
  new NextRequest(url, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

async function create(who: Who, name: string, siren: string) {
  state.user = { ...USERS[who] }
  return routes.companies.POST(jsonRequest('http://localhost/api/companies', 'POST', company(name, siren)))
}

async function patch(who: Who, id: string, body: unknown) {
  state.user = { ...USERS[who] }
  return routes.company.PATCH(jsonRequest(`http://localhost/api/companies/${id}`, 'PATCH', body), { params: Promise.resolve({ id }) })
}

async function addEstablishment(who: Who, id: string, siret: string) {
  state.user = { ...USERS[who] }
  return routes.establishments.POST(jsonRequest(`http://localhost/api/companies/${id}/establishments`, 'POST', { siret, name: 'Agence' }), {
    params: Promise.resolve({ id }),
  })
}

const json = async (response: Response) => (await response.json()) as Record<string, unknown> & { id: string; slug: string; error: string }

describe.skipIf(!available)('company identifiers in Kledg Cloud (KLEDG-R3-CLOUD-01)', () => {
  beforeAll(async () => {
    await prepareTestDatabase('cloud_identifiers')
    ;({ prisma } = await import('@/lib/prisma'))
    rls = await import('@/lib/rls/context')
    routes.companies = (await import('@/app/api/companies/route')) as unknown as Record<string, Handler>
    routes.company = (await import('@/app/api/companies/[id]/route')) as unknown as Record<string, Handler>
    routes.establishments = (await import('@/app/api/companies/[id]/establishments/route')) as unknown as Record<string, Handler>
    for (const user of Object.values(USERS)) {
      await prisma.user.create({ data: { id: user.id, email: user.email, name: user.name, role: user.role, emailVerified: true } })
    }
    await prisma.cloudBillingAccount.create({
      data: { ownerUserId: 'u-squatter', subscriptionStatus: 'trialing', planId: 'holding', trialEnd: new Date(Date.now() + 25 * DAY), trialUsed: true },
    })
    await prisma.cloudBillingAccount.create({ data: { ownerUserId: 'u-victim', subscriptionStatus: 'active', planId: 'holding' } })
  }, 120_000)

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  beforeEach(() => {
    vi.stubEnv('KLEDG_CLOUD_MODE', 'true')
  })

  it('a trial account cannot take the SIREN of a business that is not a customer yet', async () => {
    expect((await create('squatter', 'Boulangerie Martin', VICTIM_SIREN)).status).toBe(201)
    // The real business subscribes later and creates its company all the same.
    const own = await create('victim', 'Boulangerie Martin', VICTIM_SIREN)
    expect(own.status).toBe(201)
    // Same name, no hint of the other company in the slug: both carry a random suffix.
    expect((await json(own)).slug).toMatch(/^boulangerie-martin-[a-z0-9]{6}$/)
  })

  it('answers the same whether another customer uses a SIREN, a SIRET or a slug, or nobody does', async () => {
    const other = await create('victim', 'Cabinet Secret Durand', OTHER_TENANT_SIREN)
    expect(other.status).toBe(201)
    const otherBody = await json(other)
    expect((await addEstablishment('victim', otherBody.id, `${OTHER_TENANT_SIREN}00014`)).status).toBe(201)
    if (rlsMode() === 'enforce') {
      // The squatter cannot read the other customer's company: only the answers below could tell.
      const seen = await rls.withUserContext('u-squatter', () => prisma.company.count({ where: { siren: OTHER_TENANT_SIREN } }))
      expect(seen).toBe(0)
    }

    const own = await create('squatter', 'Sonde', SQUATTER_OWN_SIREN)
    expect(own.status).toBe(201)
    const ownId = (await json(own)).id

    // SIREN: another customer's and a free one both answer 200.
    expect((await patch('squatter', ownId, { siren: OTHER_TENANT_SIREN })).status).toBe(200)
    expect((await patch('squatter', ownId, { siren: FREE_SIREN })).status).toBe(200)

    // SIRET: another customer's establishment does not block this one.
    expect((await addEstablishment('squatter', ownId, `${OTHER_TENANT_SIREN}00014`)).status).toBe(201)

    // Slug: another customer's slug and a free one both answer 200, each with a new random suffix.
    const taken = await patch('squatter', ownId, { slug: otherBody.slug })
    expect(taken.status).toBe(200)
    const takenSlug = (await json(taken)).slug
    expect(takenSlug).toMatch(new RegExp(`^${otherBody.slug}-[a-z0-9]{6}$`))
    const free = await patch('squatter', ownId, { slug: 'sonde-libre' })
    expect(free.status).toBe(200)
    expect((await json(free)).slug).toMatch(/^sonde-libre-[a-z0-9]{6}$/)
    // The other customer's company kept its slug.
    expect((await prisma.company.findUniqueOrThrow({ where: { id: otherBody.id } })).slug).toBe(otherBody.slug)
  })

  it("keeps SIREN and SIRET unique within one customer's companies", async () => {
    const first = await create('victim', 'Holding Durand', SECOND_OWN_SIREN)
    expect(first.status).toBe(201)
    const again = await create('victim', 'Holding Durand bis', SECOND_OWN_SIREN)
    expect(again.status).toBe(409)
    expect((await json(again)).error).toBe(`Une société avec le SIREN ${SECOND_OWN_SIREN} existe déjà.`)

    const firstId = (await json(first)).id
    expect((await addEstablishment('victim', firstId, `${SECOND_OWN_SIREN}00016`)).status).toBe(201)
    expect((await addEstablishment('victim', firstId, `${SECOND_OWN_SIREN}00016`)).status).toBe(409)
    // The SIREN of another company of the same customer.
    expect((await patch('victim', firstId, { siren: VICTIM_SIREN })).status).toBe(409)
  })
})

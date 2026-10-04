/**
 * CGU and CGV acceptance (POST /api/cloud/terms) against PostgreSQL: the
 * acceptance of a new version is stored with its version and time, an
 * outdated version is refused, and the route needs a session and cloud mode.
 *
 * Skipped when the test database server is unreachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = await vi.hoisted(async () => {
  const { useTestDatabase } = await import('@/lib/__tests__/helpers/test-db')
  useTestDatabase('cloud_terms')
  process.env.BETTER_AUTH_SECRET ??= 'kledg-test-secret-0123456789abcdef0123456789'
  process.env.BETTER_AUTH_URL ??= 'http://localhost:3000'
  process.env.RATE_LIMIT_DISABLED = 'true'
  return { user: null as null | { id: string; email: string; name: string | null; role: string | null } }
})

vi.mock('@/lib/session', () => ({ getCurrentUser: async () => state.user }))

import { prepareTestDatabase, testDatabaseAvailable } from '@/lib/__tests__/helpers/test-db'
import { CURRENT_TERMS, currentTermsVersion, isLegalPageSlug } from '../terms'
import { LEGAL_DOCUMENTS } from '../documents'

const available = await testDatabaseAvailable()
let prisma: typeof import('@/lib/prisma').prisma
let POST: (request: Request) => Promise<Response>
let pendingTerms: typeof import('../terms-acceptance.service').pendingTerms

const USER = { id: 'u-member', email: 'member@test.local', name: 'Membre', role: 'user' }
const accept = (version: string) =>
  POST(new NextRequest('http://localhost/api/cloud/terms', { method: 'POST', body: JSON.stringify({ version }), headers: { 'content-type': 'application/json' } }))

describe('legal documents', () => {
  it('exist for every legal page, with French text without dashes', () => {
    for (const [slug, document] of Object.entries(LEGAL_DOCUMENTS)) {
      expect(isLegalPageSlug(slug)).toBe(true)
      const text = [document.intro, ...document.sections.flatMap((s) => [s.heading, ...s.paragraphs])].join('\n')
      expect(text).not.toMatch(/[–—]/)
      expect(text, slug).not.toMatch(/ [:;]/)
    }
    expect(isLegalPageSlug('toString')).toBe(false)
  })
})

describe.skipIf(!available)('terms acceptance', () => {
  beforeAll(async () => {
    await prepareTestDatabase('cloud_terms')
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ POST } = (await import('@/app/api/cloud/terms/route')) as unknown as { POST: typeof POST })
    ;({ pendingTerms } = await import('../terms-acceptance.service'))
    await prisma.user.create({ data: { ...USER, emailVerified: true } })
  }, 120_000)

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  beforeEach(() => {
    vi.stubEnv('KLEDG_CLOUD_MODE', 'true')
    state.user = { ...USER }
  })

  it('records the current versions once accepted, with the time', async () => {
    // A member created by an administrator never accepted anything: the banner asks.
    expect(await pendingTerms(USER.id)).toEqual(['cgu', 'cgv'])
    const response = await accept(currentTermsVersion())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accepted: true })
    expect(await pendingTerms(USER.id)).toEqual([])
    const rows = await prisma.cloudTermsAcceptance.findMany({ where: { userId: USER.id }, orderBy: { document: 'asc' } })
    expect(rows.map((r) => [r.document, r.version])).toEqual([
      ['cgu', CURRENT_TERMS.cgu],
      ['cgv', CURRENT_TERMS.cgv],
    ])
    // Accepting again changes nothing.
    expect((await accept(currentTermsVersion())).status).toBe(200)
    expect(await prisma.cloudTermsAcceptance.count({ where: { userId: USER.id } })).toBe(2)
  })

  it('refuses a version that is no longer the current one', async () => {
    const response = await accept('cgu:2020-01-01,cgv:2020-01-01')
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Les conditions ont changé entre-temps. Rechargez la page pour lire la nouvelle version.' })
  })

  it('needs a session and cloud mode', async () => {
    state.user = null
    expect((await accept(currentTermsVersion())).status).toBe(401)
    state.user = { ...USER }
    vi.stubEnv('KLEDG_CLOUD_MODE', '')
    expect((await accept(currentTermsVersion())).status).toBe(404)
  })
})

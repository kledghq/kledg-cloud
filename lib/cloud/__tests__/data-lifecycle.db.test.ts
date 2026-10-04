/**
 * The data commitments of Kledg Cloud against PostgreSQL, through the real
 * routes (Stripe and email delivery mocked):
 * - full export: a ZIP with the FEC of every fiscal year and every record
 *   as JSON, without secrets, open to company administrators even when the
 *   account is read-only, closed to other roles and other companies;
 * - account deletion (CGV art. 15): address and password confirmed, books
 *   acknowledged, read-only for 30 days and cancellable, then everything
 *   deleted by the maintenance job, books included;
 * - end of contract (CGV art. 14): notice with the end of the 30 day
 *   retrieval period, deletion scheduled for that date, then executed;
 * - annual renewal reminder at least a month ahead (CGV art. 12), once;
 * - unconfirmed accounts purged; the cron requires CRON_SECRET.
 *
 * Skipped when the test database server is unreachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = await vi.hoisted(async () => {
  const { useTestDatabase } = await import('@/lib/__tests__/helpers/test-db')
  useTestDatabase('cloud_data_lifecycle')
  process.env.KLEDG_CLOUD_MODE = 'true'
  process.env.BETTER_AUTH_SECRET ??= 'kledg-test-secret-0123456789abcdef0123456789'
  process.env.BETTER_AUTH_URL = 'https://app.kledg.test'
  process.env.RATE_LIMIT_DISABLED = 'true'
  return {
    user: null as null | { id: string; email: string; name: string | null; role: string | null },
    stripe: null as unknown,
    emails: [] as Array<{ to: string; subject: string; text: string }>,
  }
})

vi.mock('@/lib/session', () => ({ getCurrentUser: async () => state.user }))
vi.mock('@/lib/cloud/billing/stripe', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/cloud/billing/stripe')>()
  return { ...real, getStripe: () => state.stripe }
})
vi.mock('@/lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email')>()),
  sendEmail: vi.fn(async (message: { to: string; subject: string; text: string }) => {
    state.emails.push(message)
  }),
}))

import { prepareTestDatabase, testDatabaseAvailable } from '@/lib/__tests__/helpers/test-db'
import { form, stripeFetch } from './helpers/stripe-fixtures'
import { unzip } from './helpers/unzip'

const available = await testDatabaseAvailable()

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>
let prisma: typeof import('@/lib/prisma').prisma
let auth: typeof import('@/lib/auth').auth
const routes = {} as Record<'export' | 'deletion' | 'cron', Record<string, Handler>>
let api: ReturnType<typeof stripeFetch>

const PASSWORD = 'un-mot-de-passe-solide'
const OWNER = { id: '', email: 'owner@test.local', name: 'Claire', role: 'user' }
const ACCOUNTANT = { id: '', email: 'accountant@test.local', name: 'Comptable', role: 'user' }
const DAY = 86_400_000
const ids = {} as Record<string, string>

const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } } : { headers }),
  })

async function as<T>(user: typeof OWNER | null, run: () => Promise<T>): Promise<T> {
  state.user = user ? { ...user } : null
  return run()
}

const exportOf = (companyId: string) => routes.export.GET(request('GET', `/api/cloud/export?companyId=${companyId}`))
const cron = (secret?: string) => routes.cron.GET(request('GET', '/api/cron/cloud-maintenance', undefined, secret ? { authorization: `Bearer ${secret}` } : {}))

async function seedCompanyWithBooks(name: string, slug: string, siren: string, billingAccountId: string) {
  const company = await prisma.company.create({ data: { name, slug, siren } })
  await prisma.organization.create({ data: { id: `org-${slug}`, name, slug: `org-${slug}`, createdAt: new Date(), companyId: company.id } })
  await prisma.member.create({ data: { id: `m-${slug}-owner`, userId: OWNER.id, organizationId: `org-${slug}`, role: 'companyAdmin', createdAt: new Date() } })
  const fy = await prisma.fiscalYear.create({
    data: { companyId: company.id, year: 2025, startDate: new Date('2025-01-01T00:00:00Z'), endDate: new Date('2025-12-31T00:00:00Z') },
  })
  const bank = await prisma.account.create({ data: { companyId: company.id, fiscalYearId: fy.id, code: '512000', label: 'Banque' } })
  const sales = await prisma.account.create({ data: { companyId: company.id, fiscalYearId: fy.id, code: '706000', label: 'Ventes' } })
  const journal = await prisma.journal.create({ data: { companyId: company.id, code: 'VT', label: 'Ventes' } })
  const entry = await prisma.accountingEntry.create({
    data: { companyId: company.id, fiscalYearId: fy.id, journalId: journal.id, entryNumber: 'VT1', date: new Date('2025-03-01T00:00:00Z'), description: 'Vente', status: 'draft' },
  })
  await prisma.entryLine.createMany({
    data: [
      { accountingEntryId: entry.id, accountId: bank.id, accountFiscalYearId: fy.id, accountingEntryNumber: 'VT1', debit: 1200, credit: 0 },
      { accountingEntryId: entry.id, accountId: sales.id, accountFiscalYearId: fy.id, accountingEntryNumber: 'VT1', debit: 0, credit: 1200 },
    ],
  })
  await prisma.accountingEntry.update({ where: { id: entry.id }, data: { status: 'validated', validatedAt: new Date('2025-03-02T00:00:00Z') } })
  await prisma.bankConnection.create({ data: { companyId: company.id, provider: 'QONTO', login: 'acme', secretKeyEncrypted: 'never-exported-secret-1234' } })
  await prisma.cloudCompanyOwnership.create({ data: { companyId: company.id, billingAccountId } })
  return company.id
}

describe.skipIf(!available)('data lifecycle', () => {
  beforeAll(async () => {
    await prepareTestDatabase('cloud_data_lifecycle')
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ auth } = await import('@/lib/auth'))
    routes.export = (await import('@/app/api/cloud/export/route')) as unknown as Record<string, Handler>
    routes.deletion = (await import('@/app/api/cloud/account/deletion/route')) as unknown as Record<string, Handler>
    routes.cron = (await import('@/app/api/cron/cloud-maintenance/route')) as unknown as Record<string, Handler>
    for (const user of [OWNER, ACCOUNTANT]) {
      const created = await auth.api.createUser({ body: { email: user.email, password: PASSWORD, name: user.name, role: 'user' } })
      user.id = created.user.id
      await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } })
    }
    const account = await prisma.cloudBillingAccount.create({
      data: {
        id: 'ba-owner',
        ownerUserId: OWNER.id,
        stripeCustomerId: 'cus_TestOwner0001',
        stripeSubscriptionId: 'sub_TestKledg0001',
        subscriptionStatus: 'active',
        planId: 'holding',
        billingInterval: 'year',
        trialUsed: true,
      },
    })
    ids.atelier = await seedCompanyWithBooks('Atelier Lumen', 'atelier-lumen', '912345675', account.id)
    await prisma.member.create({ data: { id: 'm-acc', userId: ACCOUNTANT.id, organizationId: 'org-atelier-lumen', role: 'accountant', createdAt: new Date() } })
    ids.other = (await prisma.company.create({ data: { name: 'Autre', slug: 'autre', siren: '912345683' } })).id
  }, 120_000)

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  beforeEach(() => {
    vi.stubEnv('KLEDG_CLOUD_MODE', 'true')
    vi.stubEnv('CRON_SECRET', 'test-cron-secret-0123456789')
    state.emails.length = 0
    api = stripeFetch({
      'POST /v1/subscriptions/sub_TestKledg0001': { id: 'sub_TestKledg0001', object: 'subscription', status: 'active', cancel_at_period_end: true },
      'DELETE /v1/subscriptions/sub_TestKledg0001': { id: 'sub_TestKledg0001', object: 'subscription', status: 'canceled' },
    })
    state.stripe = api.stripe
  })

  describe('full export', () => {
    it('gives a company administrator the FEC of each fiscal year and every record as JSON, without secrets', async () => {
      const response = await as(OWNER, () => exportOf(ids.atelier))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/zip')
      expect(response.headers.get('content-disposition')).toMatch(/attachment; filename="kledg-export-atelier-lumen-\d{4}-\d{2}-\d{2}\.zip"/)
      const files = unzip(new Uint8Array(await response.arrayBuffer()))
      expect(Object.keys(files)).toEqual(
        expect.arrayContaining(['LISEZMOI.txt', 'fec/912345675FEC20251231.txt', 'donnees/societe.json', 'donnees/ecritures.json', 'donnees/banque-connexions.json']),
      )
      const fec = files['fec/912345675FEC20251231.txt'].split('\n')
      expect(fec[0].split('\t')[0]).toBe('JournalCode')
      expect(fec.some((line) => line.startsWith('VT\t') && line.includes('VT1'))).toBe(true)
      const entries = JSON.parse(files['donnees/ecritures.json']) as Array<{ entryNumber: string; lines: Array<{ debit: string }> }>
      expect(entries[0].entryNumber).toBe('VT1')
      expect(entries[0].lines.map((l) => l.debit).sort()).toEqual(['0', '1200'])
      const everything = Object.values(files).join('\n')
      expect(everything).not.toContain('never-exported-secret-1234')
      expect(everything).not.toMatch(/"(secretKeyEncrypted|password|token)"/)
      expect(JSON.parse(files['donnees/banque-connexions.json'])).toEqual([expect.objectContaining({ provider: 'QONTO' })])
      expect(await prisma.auditLog.count({ where: { action: 'CLOUD_DATA_EXPORT', companyId: ids.atelier } })).toBe(1)
    })

    it('is refused to an accountant (403), to another company (404) and to anonymous callers (401)', async () => {
      expect((await as(ACCOUNTANT, () => exportOf(ids.atelier))).status).toBe(403)
      expect((await as(OWNER, () => exportOf(ids.other))).status).toBe(404)
      expect((await as(null, () => exportOf(ids.atelier))).status).toBe(401)
    })
  })

  describe('account deletion requested by the owner', () => {
    const schedule = (body: unknown) => as(OWNER, () => routes.deletion.POST(request('POST', '/api/cloud/account/deletion', body)))

    it('previews what would go and requires the address, the password and the books acknowledgement', async () => {
      const preview = await as(OWNER, () => routes.deletion.GET(request('GET', '/api/cloud/account/deletion')))
      expect(await preview.json()).toEqual({
        scheduledFor: null,
        reason: null,
        deletionDays: 30,
        companies: [{ id: ids.atelier, name: 'Atelier Lumen', hasBooks: true }],
        blockers: [],
      })
      expect(await (await schedule({ email: 'autre@test.local', password: PASSWORD, acknowledgeBooksDeletion: true })).json()).toEqual({
        error: "L'adresse saisie ne correspond pas à celle de votre compte.",
      })
      expect((await schedule({ email: OWNER.email, password: 'mauvais-mot-de-passe', acknowledgeBooksDeletion: true })).status).toBe(400)
      const books = await schedule({ email: OWNER.email, password: PASSWORD })
      expect(books.status).toBe(400)
      expect(((await books.json()) as { error: string }).error).toMatch(/^Confirmez que vous avez exporté vos livres comptables :/)
      expect((await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { id: 'ba-owner' } })).deletionScheduledFor).toBeNull()
    })

    it('schedules it 30 days ahead, read-only meanwhile, stops the renewal, confirms by email, and can be cancelled', async () => {
      const response = await schedule({ email: OWNER.email.toUpperCase(), password: PASSWORD, acknowledgeBooksDeletion: true })
      expect(response.status).toBe(200)
      const account = await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { id: 'ba-owner' } })
      expect(account.deletionReason).toBe('requested')
      expect(Math.round(((account.deletionScheduledFor?.getTime() ?? 0) - Date.now()) / DAY)).toBe(30)
      expect(form(api.calls[0].body)).toEqual({ cancel_at_period_end: 'true' })
      expect(state.emails.map((e) => e.subject)).toEqual(['Suppression de votre compte Kledg programmée'])
      const { assertCompanyWritable } = await import('@/lib/companies/archive-company.service')
      await expect(assertCompanyWritable(ids.atelier)).rejects.toMatchObject({ statusCode: 409 })
      // Exports stay open.
      expect((await as(OWNER, () => exportOf(ids.atelier))).status).toBe(200)

      const cancel = await as(OWNER, () => routes.deletion.DELETE(request('DELETE', '/api/cloud/account/deletion')))
      expect(cancel.status).toBe(200)
      expect((await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { id: 'ba-owner' } })).deletionScheduledFor).toBeNull()
      await expect(assertCompanyWritable(ids.atelier)).resolves.toBeUndefined()
    })
  })

  describe('maintenance job', () => {
    it('requires the CRON_SECRET bearer token', async () => {
      expect((await cron()).status).toBe(401)
      expect((await cron('wrong-secret-0123456789abcd')).status).toBe(401)
    })

    it('reminds an annual renewal at least a month ahead, once per period', async () => {
      const renewal = new Date(Date.now() + 33 * DAY)
      await prisma.cloudBillingAccount.update({ where: { id: 'ba-owner' }, data: { currentPeriodEnd: renewal, cancelAtPeriodEnd: false } })
      const first = await cron('test-cron-secret-0123456789')
      expect(first.status).toBe(200)
      expect(await first.json()).toMatchObject({ renewalReminders: 1 })
      expect(state.emails.map((e) => [e.to, e.subject.startsWith('Renouvellement de votre abonnement Kledg le ')])).toEqual([[OWNER.email, true]])
      expect(state.emails[0].text).toContain('offre Holding')
      expect(await (await cron('test-cron-secret-0123456789')).json()).toMatchObject({ renewalReminders: 0 })
      // A renewal further than the notice period waits.
      await prisma.cloudBillingAccount.update({ where: { id: 'ba-owner' }, data: { currentPeriodEnd: new Date(Date.now() + 60 * DAY) } })
      expect(await (await cron('test-cron-secret-0123456789')).json()).toMatchObject({ renewalReminders: 0 })
    })

    it('sends the end of contract notice with the retrieval date, then deletes everything on that date', async () => {
      const ended = new Date(Date.now() - 2 * DAY)
      await prisma.cloudBillingAccount.update({ where: { id: 'ba-owner' }, data: { subscriptionStatus: 'canceled', subscriptionEndedAt: ended } })
      expect(await (await cron('test-cron-secret-0123456789')).json()).toMatchObject({ endedContracts: 1, deletions: { done: 0, failed: 0 } })
      const account = await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { id: 'ba-owner' } })
      expect(account).toMatchObject({ deletionReason: 'contract_ended', deletionScheduledFor: new Date(ended.getTime() + 30 * DAY), contractEndNoticeFor: ended })
      expect(state.emails.map((e) => e.subject)).toEqual(['Votre abonnement Kledg a pris fin'])
      expect(state.emails[0].text).toMatch(/jusqu'au \d+ \S+ \d{4}/)
      expect(state.emails[0].text).toContain('Code de commerce art. L123-22')
      // Not cancellable from the data page: subscribing again keeps the account.
      expect((await as(OWNER, () => routes.deletion.DELETE(request('DELETE', '/api/cloud/account/deletion')))).status).toBe(409)
      expect(await (await cron('test-cron-secret-0123456789')).json()).toMatchObject({ endedContracts: 0 })

      // The retrieval period is over: the account, its companies and their books go.
      await prisma.cloudBillingAccount.update({ where: { id: 'ba-owner' }, data: { deletionScheduledFor: new Date(Date.now() - 1000) } })
      state.emails.length = 0
      expect(await (await cron('test-cron-secret-0123456789')).json()).toMatchObject({ deletions: { done: 1, failed: 0 } })
      expect(await prisma.company.findUnique({ where: { id: ids.atelier } })).toBeNull()
      expect(await prisma.accountingEntry.count({ where: { companyId: ids.atelier } })).toBe(0)
      expect(await prisma.user.findUnique({ where: { id: OWNER.id } })).toBeNull()
      expect(await prisma.authAccount.count({ where: { userId: OWNER.id } })).toBe(0)
      expect(await prisma.cloudBillingAccount.count({ where: { id: 'ba-owner' } })).toBe(0)
      expect(await prisma.cloudTermsAcceptance.count({ where: { userId: OWNER.id } })).toBe(0)
      // The subscription was no longer live: nothing to cancel at Stripe.
      expect(api.calls.filter((c) => c.method === 'DELETE')).toEqual([])
      expect(state.emails.map((e) => [e.to, e.subject])).toEqual([[OWNER.email, 'Votre compte Kledg a été supprimé']])
      // Other companies are untouched.
      expect(await prisma.company.findUnique({ where: { id: ids.other } })).not.toBeNull()
    })

    it('deletes accounts never confirmed after a week, and only those', async () => {
      const old = new Date(Date.now() - 8 * DAY)
      await prisma.user.create({ data: { id: 'u-stale', email: 'stale@test.local', name: 'x', role: 'user', emailVerified: false, createdAt: old } })
      await prisma.user.create({ data: { id: 'u-recent', email: 'recent@test.local', name: 'x', role: 'user', emailVerified: false } })
      await prisma.cloudTermsAcceptance.create({ data: { userId: 'u-stale', document: 'cgv', version: '1.0' } })
      expect(await (await cron('test-cron-secret-0123456789')).json()).toMatchObject({ unverifiedPurged: 1 })
      expect(await prisma.user.findUnique({ where: { id: 'u-stale' } })).toBeNull()
      expect(await prisma.cloudTermsAcceptance.count({ where: { userId: 'u-stale' } })).toBe(0)
      expect(await prisma.user.findUnique({ where: { id: 'u-recent' } })).not.toBeNull()
      expect(await prisma.user.findUnique({ where: { id: ACCOUNTANT.id } })).not.toBeNull()
    })
  })
})

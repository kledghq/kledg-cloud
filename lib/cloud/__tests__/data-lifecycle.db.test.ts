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
 *   the export of the retrieval period holds the receipt files, then the
 *   purge deletes their rows and, after the commit, their objects in the
 *   object storage, objects no row knew under the company's prefix
 *   included (Kledg Cloud is the processor, docs/cloud.md);
 * - a stored object whose deletion fails stays pending (never a row
 *   pointing to a deleted object), and the maintenance job deletes it on a
 *   later run;
 * - annual renewal reminder at least a month ahead (CGV art. 12), once;
 * - unconfirmed accounts purged; the cron requires CRON_SECRET;
 * - KLEDG_STORAGE_MIGRATE=on at server start moves receipt files from
 *   PostgreSQL to the Blob store (a fake) in its own system context
 *   ('storage-migration'), without the tests' system fallback, so it works
 *   under KLEDG_RLS=enforce as in production.
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
import { unzip, unzipEntries } from './helpers/unzip'

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

  describe('receipt storage', () => {
    it('moves receipt files to the Blob store at server start, in the storage-migration context (KLEDG_RLS=enforce)', async () => {
      const { createHash } = await import('node:crypto')
      const { setObjectStorageForTests } = await import('@/lib/storage')
      const { migrateReceiptStorageOnStart } = await import('@/lib/receipts/migrate-receipt-storage.service')
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 1])
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const file = await prisma.receiptFile.create({ data: { companyId: ids.other, sha256, contentType: 'image/jpeg', size: bytes.length, content: bytes } })
      const objects = new Map<string, Uint8Array>()
      setObjectStorageForTests('blob', {
        driver: 'blob',
        put: async (key, body) => void objects.set(key, body),
        get: async (key) => objects.get(key) ?? null,
        getStream: async () => null,
        delete: async (key) => void objects.delete(key),
        exists: async (key) => objects.has(key),
      })
      vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_test')
      // No fallback context: the migration runs as at server start, with only the context it sets itself.
      vi.stubEnv('KLEDG_RLS_TEST_CONTEXT', '')
      try {
        await migrateReceiptStorageOnStart({ KLEDG_STORAGE_MIGRATE: 'on' })
      } finally {
        vi.stubEnv('KLEDG_RLS_TEST_CONTEXT', process.env.KLEDG_RLS === 'enforce' ? 'system' : '')
        setObjectStorageForTests('blob', null)
      }
      const moved = await prisma.receiptFile.findUniqueOrThrow({ where: { id: file.id } })
      expect([moved.storageDriver, moved.content]).toEqual(['blob', null])
      expect(moved.storageKey).toMatch(new RegExp(`^receipts/${ids.other}/`))
      expect(objects.get(moved.storageKey!)).toEqual(bytes)
      await prisma.receiptFile.delete({ where: { id: file.id } })
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

      // A receipt kept in the private Blob store (a fake here), staged and attached as a supporting document.
      const objects = new Map<string, Uint8Array>()
      const deleted: string[] = []
      const { setObjectStorageForTests } = await import('@/lib/storage')
      const { setPrefixListerForTests } = await import('@/lib/cloud/account/receipt-objects.service')
      vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_test')
      setPrefixListerForTests({ keys: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)) })
      setObjectStorageForTests('blob', {
        driver: 'blob',
        put: async (key, body) => void objects.set(key, body),
        get: async (key) => objects.get(key) ?? null,
        getStream: async () => null,
        delete: async (key) => {
          deleted.push(key)
          objects.delete(key)
        },
        exists: async (key) => objects.has(key),
      })
      const { createHash } = await import('node:crypto')
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const key = `receipts/${ids.atelier}/kept0123456789abcdef`
      objects.set(key, bytes)
      // An object no row knows (an upload whose row was never created), under the company's prefix.
      const orphan = `receipts/${ids.atelier}/orphan0123456789abcd`
      objects.set(orphan, new Uint8Array([1, 2, 3]))
      // Another company's object stays.
      const otherKey = `receipts/${ids.other}/other0123456789abcdef`
      objects.set(otherKey, new Uint8Array([4, 5, 6]))
      const file = await prisma.receiptFile.create({
        data: { companyId: ids.atelier, sha256, contentType: 'image/jpeg', size: bytes.length, storageDriver: 'blob', storageKey: key },
      })
      await prisma.stagedReceipt.create({
        data: { companyId: ids.atelier, fileId: file.id, sha256, fileName: 'ticket.jpg', contentType: 'image/jpeg', size: bytes.length, source: 'app', expiresAt: new Date(Date.now() + 30 * DAY) },
      })
      await prisma.attachment.create({ data: { companyId: ids.atelier, fileName: 'ticket.jpg', receiptFileId: file.id } })

      // During the retrieval period, the full export holds the receipt file and its manifest.
      const archive = await as(OWNER, () => exportOf(ids.atelier))
      expect(archive.status).toBe(200)
      const entries = unzipEntries(new Uint8Array(await archive.arrayBuffer()))
      const receiptEntries = Object.keys(entries).filter((name) => name.startsWith('justificatifs/') && name.endsWith('ticket.jpg'))
      expect(receiptEntries).toHaveLength(1)
      expect([...entries[receiptEntries[0]].bytes]).toEqual([...bytes])
      const manifest = new TextDecoder().decode(entries['justificatifs/manifeste.csv'].bytes)
      expect(manifest).toContain(sha256)
      expect(manifest).toContain('inclus')

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
      // Receipts: the rows go with the company, then the stored object and the orphan under its prefix.
      expect(await prisma.receiptFile.count({ where: { id: file.id } })).toBe(0)
      expect(await prisma.stagedReceipt.count({ where: { companyId: ids.atelier } })).toBe(0)
      expect(deleted.sort()).toEqual([key, orphan].sort())
      expect([...objects.keys()]).toEqual([otherKey])
      expect(await prisma.cloudPendingObjectDeletion.count()).toBe(0)
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'CLOUD_ACCOUNT_DELETED' }, orderBy: { createdAt: 'desc' } })
      expect(audit.metadata).toMatchObject({ companies: [ids.atelier], deletedReceiptObjects: 2, pendingReceiptObjects: 0 })
      expect(audit.metadata).not.toHaveProperty('retainedReceiptObjects')
      setObjectStorageForTests('blob', null)
      setPrefixListerForTests(null)
      // The subscription was no longer live: nothing to cancel at Stripe.
      expect(api.calls.filter((c) => c.method === 'DELETE')).toEqual([])
      expect(state.emails.map((e) => [e.to, e.subject])).toEqual([[OWNER.email, 'Votre compte Kledg a été supprimé']])
      // Other companies are untouched.
      expect(await prisma.company.findUnique({ where: { id: ids.other } })).not.toBeNull()
    })

    it('keeps a stored object whose deletion failed pending, without its row, and deletes it on a later run', async () => {
      const { createHash } = await import('node:crypto')
      const { setObjectStorageForTests } = await import('@/lib/storage')
      const { setPrefixListerForTests } = await import('@/lib/cloud/account/receipt-objects.service')
      const user = await prisma.user.create({ data: { id: 'u-leaving', email: 'leaving@test.local', name: 'Partant', role: 'user', emailVerified: true } })
      const account = await prisma.cloudBillingAccount.create({
        data: { ownerUserId: user.id, deletionReason: 'requested', deletionRequestedAt: new Date(Date.now() - 31 * DAY), deletionScheduledFor: new Date(Date.now() - 1000) },
      })
      const company = await prisma.company.create({ data: { name: 'Partante', slug: 'partante', siren: '912345691' } })
      await prisma.organization.create({ data: { id: 'org-partante', name: 'Partante', slug: 'org-partante', createdAt: new Date(), companyId: company.id } })
      await prisma.member.create({ data: { id: 'm-partante', userId: user.id, organizationId: 'org-partante', role: 'companyAdmin', createdAt: new Date() } })
      await prisma.cloudCompanyOwnership.create({ data: { companyId: company.id, billingAccountId: account.id } })
      const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const key = `receipts/${company.id}/failing0123456789abcd`
      await prisma.receiptFile.create({ data: { companyId: company.id, sha256, contentType: 'application/pdf', size: 4, storageDriver: 'blob', storageKey: key } })

      // The store refuses deletions for now.
      const objects = new Map<string, Uint8Array>([[key, bytes]])
      let refuse = true
      setObjectStorageForTests('blob', {
        driver: 'blob',
        put: async (k, body) => void objects.set(k, body),
        get: async (k) => objects.get(k) ?? null,
        getStream: async () => null,
        delete: async (k) => {
          if (refuse) throw new Error('Blob store unavailable')
          objects.delete(k)
        },
        exists: async (k) => objects.has(k),
      })
      vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_test')
      setPrefixListerForTests({ keys: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)) })
      try {
        expect(await (await cron('test-cron-secret-0123456789')).json()).toMatchObject({ deletions: { done: 1, failed: 0 }, receiptObjects: { deleted: 0, pending: 2 } })
        // The company and its rows are gone; the object waits, recorded for the next runs.
        expect(await prisma.company.findUnique({ where: { id: company.id } })).toBeNull()
        expect(await prisma.receiptFile.count({ where: { companyId: company.id } })).toBe(0)
        expect(objects.has(key)).toBe(true)
        const pending = await prisma.cloudPendingObjectDeletion.findMany({ orderBy: { kind: 'asc' } })
        expect(pending.map((row) => [row.kind, row.storageDriver, row.target])).toEqual([
          ['object', 'blob', key],
          ['prefix', 'blob', `receipts/${company.id}/`],
        ])
        // Two attempts: the purge itself, then the retry step of the same run.
        expect(pending.every((row) => row.attempts === 2 && row.lastAttemptAt !== null)).toBe(true)
        const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'CLOUD_ACCOUNT_DELETED' }, orderBy: { createdAt: 'desc' } })
        expect(audit.metadata).toMatchObject({ companies: [company.id], deletedReceiptObjects: 0, pendingReceiptObjects: 2 })

        // The store is back: the next run deletes the object and clears the pending rows.
        refuse = false
        expect(await (await cron('test-cron-secret-0123456789')).json()).toMatchObject({ receiptObjects: { deleted: 1, pending: 0 } })
        expect(objects.size).toBe(0)
        expect(await prisma.cloudPendingObjectDeletion.count()).toBe(0)
        const retried = await prisma.auditLog.findFirstOrThrow({ where: { action: 'CLOUD_RECEIPT_OBJECTS_DELETED' }, orderBy: { createdAt: 'desc' } })
        expect(retried.metadata).toMatchObject({ deletedReceiptObjects: 1, pendingReceiptObjects: 0 })
        expect(await (await cron('test-cron-secret-0123456789')).json()).toMatchObject({ receiptObjects: { deleted: 0, pending: 0 } })
      } finally {
        setObjectStorageForTests('blob', null)
        setPrefixListerForTests(null)
      }
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

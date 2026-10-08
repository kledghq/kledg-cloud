/**
 * Receipt files in the full export (lib/cloud/export/receipt-files.ts),
 * against PostgreSQL through GET /api/cloud/export (session mocked, object
 * storage a fake Blob store):
 * - every file the company keeps is in justificatifs/<date>_<name>, byte
 *   for byte, whatever its driver (postgres row, Blob object), stored
 *   without deflate; names are unique;
 * - the manifest (CSV and JSON) maps each file to its bank transaction,
 *   expense line (with its report) or waiting receipt;
 * - a file missing from the storage or altered (SHA-256) is left out and
 *   listed as such, the export goes on;
 * - another company's files never appear;
 * - files are read one at a time; above the size cap none is embedded and
 *   the manifest lists them as not included.
 * Runs under KLEDG_RLS=enforce too. Skipped when the test database server is
 * unreachable.
 */

import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = await vi.hoisted(async () => {
  const { useTestDatabase } = await import('@/lib/__tests__/helpers/test-db')
  useTestDatabase('cloud_export_receipts')
  process.env.KLEDG_CLOUD_MODE = 'true'
  process.env.BETTER_AUTH_SECRET ??= 'kledg-test-secret-0123456789abcdef0123456789'
  process.env.BETTER_AUTH_URL = 'https://app.kledg.test'
  process.env.RATE_LIMIT_DISABLED = 'true'
  return { user: null as null | { id: string; email: string; name: string | null; role: string | null } }
})

vi.mock('@/lib/session', () => ({ getCurrentUser: async () => state.user }))

import { prepareTestDatabase, testDatabaseAvailable } from '@/lib/__tests__/helpers/test-db'
import { unzipEntries } from '../../__tests__/helpers/unzip'

const available = await testDatabaseAvailable()

type Handler = (request: Request) => Promise<Response>
let prisma: typeof import('@/lib/prisma').prisma
let route: Record<'GET', Handler>

const OWNER = { id: 'u-owner', email: 'owner@test.local', name: 'Claire', role: 'user' }
const ids = {} as Record<string, string>
const objects = new Map<string, Uint8Array>()

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const jpeg = (seed: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 64 }, (_, i) => (i * seed) % 256)])
const pdf = new Uint8Array([...new TextEncoder().encode('%PDF-1.4\n'), 1, 2, 3, 4, 5])

async function receiptFile(companyId: string, bytes: Uint8Array, contentType: string, driver: 'postgres' | 'blob', suffix: string, stored: Uint8Array | null = bytes) {
  if (driver === 'postgres') {
    return prisma.receiptFile.create({ data: { companyId, sha256: sha(bytes), contentType, size: bytes.length, content: Buffer.from(bytes) } })
  }
  const key = `receipts/${companyId}/object${suffix}0123456789abcdef`
  if (stored) objects.set(key, stored)
  return prisma.receiptFile.create({ data: { companyId, sha256: sha(bytes), contentType, size: bytes.length, storageDriver: 'blob', storageKey: key } })
}

async function seed() {
  await prisma.user.create({ data: { ...OWNER, emailVerified: true } })
  for (const [key, name, slug, siren] of [['a', 'Atelier Lumen', 'atelier-lumen', '912345675'], ['b', 'Bureau Beta', 'bureau-beta', '912345683']]) {
    const company = await prisma.company.create({ data: { name, slug, siren } })
    await prisma.organization.create({ data: { id: `org-${key}`, name, slug: `org-${slug}`, createdAt: new Date(), companyId: company.id } })
    await prisma.member.create({ data: { id: `m-${key}`, userId: OWNER.id, organizationId: `org-${key}`, role: 'companyAdmin', createdAt: new Date() } })
    ids[key] = company.id
  }
  const a = ids.a
  const connection = await prisma.bankConnection.create({ data: { companyId: a, provider: 'QONTO', login: 'acme' } })
  const account = await prisma.bankAccount.create({ data: { bankConnectionId: connection.id, externalAccountId: 'FR76-1', name: 'Compte courant' } })
  const line = await prisma.bankTransaction.create({
    data: { bankAccountId: account.id, externalTransactionId: 't-1', amount: '42.00', date: new Date('2026-09-30T00:00:00Z'), side: 'debit', label: 'Boulangerie; Paris' },
  })
  ids.transaction = line.id

  // 1. A photo kept in PostgreSQL, filed on the bank line.
  const onLine = await receiptFile(a, jpeg(3), 'image/jpeg', 'postgres', 'a')
  ids.onLine = onLine.id
  ids.attachment = (await prisma.attachment.create({ data: { companyId: a, fileName: 'ticket.jpg', receiptFileId: onLine.id, bankTransactionId: line.id } })).id

  // 2. A PDF in the Blob store, receipt of an expense line; same name as the first one, other day.
  const claimant = await prisma.expenseClaimant.create({ data: { companyId: a, kind: 'EMPLOYEE', name: 'Paul', auxiliaryAccountNumber: 'PAUL' } })
  const report = await prisma.expenseReport.create({
    data: {
      companyId: a,
      claimantId: claimant.id,
      number: 'NDF-0001',
      periodStart: new Date('2026-09-01T00:00:00Z'),
      periodEnd: new Date('2026-09-30T00:00:00Z'),
      totalInclTax: '18.50',
      recoverableVat: '0',
      totalExpense: '18.50',
    },
  })
  ids.report = report.id
  const onExpense = await receiptFile(a, pdf, 'application/pdf', 'blob', 'b')
  const expenseAttachment = await prisma.attachment.create({ data: { companyId: a, fileName: '../factures/Taxi "Gare".pdf', receiptFileId: onExpense.id } })
  ids.expenseLine = (
    await prisma.expenseLine.create({
      data: { reportId: report.id, position: 1, date: new Date('2026-09-12T00:00:00Z'), label: 'Taxi', category: 'TRAVEL', amountInclTax: '18.50', receiptAttachmentId: expenseAttachment.id },
    })
  ).id

  // 3. Waiting to be filed, in the Blob store, same name and date as the first one.
  const waiting = await receiptFile(a, jpeg(5), 'image/jpeg', 'blob', 'c')
  ids.staged = (
    await prisma.stagedReceipt.create({
      data: { companyId: a, fileId: waiting.id, sha256: waiting.sha256, fileName: 'ticket.jpg', contentType: 'image/jpeg', size: waiting.size, source: 'app', receiptDate: new Date('2026-09-30T00:00:00Z'), expiresAt: new Date(Date.now() + 86_400_000) },
    })
  ).id

  // 4. Altered in the bucket (SHA-256 no longer matches) and 5. gone from the bucket.
  const altered = await receiptFile(a, jpeg(7), 'image/jpeg', 'blob', 'd', jpeg(8))
  await prisma.attachment.create({ data: { companyId: a, fileName: 'altere.jpg', receiptFileId: altered.id } })
  const missing = await receiptFile(a, jpeg(9), 'image/jpeg', 'blob', 'e', null)
  await prisma.attachment.create({ data: { companyId: a, fileName: 'perdu.jpg', receiptFileId: missing.id } })

  // Another company's receipt, never in this export.
  const other = await receiptFile(ids.b, jpeg(11), 'image/jpeg', 'postgres', 'f')
  await prisma.attachment.create({ data: { companyId: ids.b, fileName: 'secret-beta.jpg', receiptFileId: other.id } })
}

async function exportOf(companyId: string) {
  state.user = { ...OWNER }
  const response = await route.GET(new NextRequest(`http://localhost/api/cloud/export?companyId=${companyId}`))
  expect(response.status).toBe(200)
  return unzipEntries(new Uint8Array(await response.arrayBuffer()))
}

describe.skipIf(!available)('receipt files in the full export', () => {
  beforeAll(async () => {
    await prepareTestDatabase('cloud_export_receipts')
    ;({ prisma } = await import('@/lib/prisma'))
    route = (await import('@/app/api/cloud/export/route')) as unknown as Record<'GET', Handler>
    const { setObjectStorageForTests } = await import('@/lib/storage')
    setObjectStorageForTests('blob', {
      driver: 'blob',
      put: async (key, body) => void objects.set(key, body),
      get: async (key) => objects.get(key) ?? null,
      getStream: async () => null,
      delete: async (key) => void objects.delete(key),
      exists: async (key) => objects.has(key),
    })
    await seed()
  }, 120_000)

  afterEach(() => {
    state.user = null
  })

  afterAll(async () => {
    const { setObjectStorageForTests } = await import('@/lib/storage')
    setObjectStorageForTests('blob', null)
    await prisma?.$disconnect()
  })

  it('puts every stored receipt in justificatifs/, byte for byte, with a manifest of what each one justifies', async () => {
    const files = await exportOf(ids.a)
    const receipts = Object.keys(files).filter((name) => name.startsWith('justificatifs/')).sort()
    expect(receipts).toEqual([
      'justificatifs/2026-09-12_factures Taxi Gare .pdf',
      'justificatifs/2026-09-30_ticket-2.jpg',
      'justificatifs/2026-09-30_ticket.jpg',
      'justificatifs/manifeste.csv',
      'justificatifs/manifeste.json',
    ].sort())
    expect([...files['justificatifs/2026-09-30_ticket.jpg'].bytes]).toEqual([...jpeg(3)])
    expect([...files['justificatifs/2026-09-30_ticket-2.jpg'].bytes]).toEqual([...jpeg(5)])
    expect([...files['justificatifs/2026-09-12_factures Taxi Gare .pdf'].bytes]).toEqual([...pdf])
    // Photos and PDFs are stored as they are.
    expect(files['justificatifs/2026-09-30_ticket.jpg'].method).toBe(0)

    const decoder = new TextDecoder()
    const manifest = JSON.parse(decoder.decode(files['justificatifs/manifeste.json'].bytes)) as Array<Record<string, unknown>>
    const byFile = (name: string) => manifest.filter((row) => row.fichier === `justificatifs/${name}`)
    expect(byFile('2026-09-30_ticket.jpg')).toEqual([
      expect.objectContaining({
        statut: 'inclus',
        lien: 'transaction bancaire',
        pieceId: ids.attachment,
        transactionId: ids.transaction,
        transactionDate: '2026-09-30',
        transactionLibelle: 'Boulangerie; Paris',
        transactionMontant: '42',
        transactionSens: 'debit',
        stockage: 'postgres',
        sha256: sha(jpeg(3)),
      }),
    ])
    expect(byFile('2026-09-12_factures Taxi Gare .pdf')).toEqual([
      expect.objectContaining({ statut: 'inclus', lien: 'ligne de note de frais', noteDeFraisId: ids.report, noteDeFraisNumero: 'NDF-0001', ligneNoteDeFraisId: ids.expenseLine, ligneDate: '2026-09-12', ligneMontantTTC: '18.5', stockage: 'blob' }),
    ])
    expect(byFile('2026-09-30_ticket-2.jpg')).toEqual([
      expect.objectContaining({ statut: 'inclus', lien: 'justificatif en attente', justificatifEnAttenteId: ids.staged, justificatifStatut: 'staged' }),
    ])
    // Altered or gone: left out, said so, the export went on.
    expect(manifest.filter((row) => row.statut !== 'inclus').map((row) => [row.statut, (row.fichier as string).replace(/^justificatifs\/\d{4}-\d{2}-\d{2}_/, '')]).sort()).toEqual([
      ['introuvable', 'altere.jpg'],
      ['introuvable', 'perdu.jpg'],
    ])
    expect(Object.keys(files).some((name) => name.includes('altere') || name.includes('perdu'))).toBe(false)

    const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(files['justificatifs/manifeste.csv'].bytes)
    expect(csv.startsWith('﻿fichier;statut;lien;transactionId')).toBe(true)
    expect(csv).toContain('justificatifs/2026-09-30_ticket.jpg;inclus;transaction bancaire;')
    expect(csv).toContain('"Boulangerie; Paris"')
    expect(csv.trimEnd().split('\r\n')).toHaveLength(1 + manifest.length)

    // The other company's receipt is not there, and the read me says what the folder holds.
    const everything = Object.values(files).map((f) => decoder.decode(f.bytes)).join('\n')
    expect(everything).not.toContain('secret-beta')
    expect(decoder.decode(files['LISEZMOI.txt'].bytes)).toContain('justificatifs/')
    expect(decoder.decode(files['donnees/pieces-justificatives.json'].bytes)).toContain('ticket.jpg')
  })

  it('reads one file at a time, and lists without embedding them above the size cap', async () => {
    const { companyExportEntries } = await import('../export-company-data.service')
    const { readReceiptFileBytes } = await import('@/lib/receipts/receipt-file-store')
    const { runWithRlsContext } = await import('@/lib/rls/context')
    const asOwner = <T,>(step: () => T) => runWithRlsContext({ access: 'user', userId: OWNER.id }, step)
    let reading = 0
    let most = 0
    const read: typeof readReceiptFileBytes = async (row) => {
      reading += 1
      most = Math.max(most, reading)
      try {
        return await readReceiptFileBytes(row)
      } finally {
        reading -= 1
      }
    }
    const names: string[] = []
    await asOwner(async () => {
      for await (const entry of companyExportEntries(ids.a, new Date(), { read })) names.push(entry.name)
    })
    expect(most).toBe(1)
    expect(names.filter((n) => n.startsWith('justificatifs/'))).toHaveLength(5)

    const capped: Array<{ name: string; data: Uint8Array | string }> = []
    await asOwner(async () => {
      for await (const entry of companyExportEntries(ids.a, new Date(), { maxBytes: 10, read })) capped.push(entry)
    })
    expect(capped.filter((e) => e.name.startsWith('justificatifs/')).map((e) => e.name)).toEqual(['justificatifs/manifeste.csv', 'justificatifs/manifeste.json'])
    const manifest = JSON.parse(capped.find((e) => e.name === 'justificatifs/manifeste.json')!.data as string) as Array<{ statut: string }>
    expect(new Set(manifest.map((row) => row.statut))).toEqual(new Set(['non inclus']))
    expect(manifest).toHaveLength(5)
    expect(capped.find((e) => e.name === 'LISEZMOI.txt')!.data).toMatch(/Vos 5 justificatifs représentent [\s\S]*ne sont pas dans cette archive/)
  })

  it('adds no justificatifs folder for a company without receipt files', async () => {
    await prisma.attachment.deleteMany({ where: { companyId: ids.b } })
    await prisma.receiptFile.deleteMany({ where: { companyId: ids.b } })
    const files = await exportOf(ids.b)
    expect(Object.keys(files).filter((name) => name.startsWith('justificatifs/'))).toEqual([])
    expect(new TextDecoder().decode(files['LISEZMOI.txt'].bytes)).not.toContain('justificatifs/')
  })
})

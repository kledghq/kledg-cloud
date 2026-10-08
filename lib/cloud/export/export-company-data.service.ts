/**
 * Full export of a company's data (RGPD art. 20, data portability; and the
 * client's own copy of its books, Code de commerce art. L123-22). A ZIP
 * archive with:
 *
 * - fec/: the FEC of every fiscal year (LPF art. A47 A-1), the format any
 *   French accounting software imports;
 * - donnees/*.json: every record of the company, as JSON (identity,
 *   establishments, shareholders, persons, addresses, fiscal years, chart of
 *   accounts, journals, entries and their lines, bank accounts and
 *   transactions, fixed assets, tiers, invoices, assignment rules,
 *   attachments metadata, tax regimes);
 * - justificatifs/: the receipt files Kledg keeps for the company, wherever
 *   they are stored, checked against their SHA-256, with a manifest mapping
 *   each file to its bank transaction or expense line (receipt-files.ts);
 * - LISEZMOI.txt: what each file holds.
 *
 * Always available, read-only accounts included (GET, never refused by the
 * billing restrictions). Credentials, tokens and other secrets are never
 * exported: they are removed by key name at any depth. Large tables are
 * read in pages; the archive is streamed entry by entry (zip.ts).
 */

import { prisma } from '@/lib/prisma'
import { exportFec } from '@/lib/fec/export'
import { writeAuditLog } from '@/lib/audit'
import { currentRlsContext, runWithRlsContext } from '@/lib/rls/context'
import { planReceiptExport, receiptFileEntries, RECEIPTS_FOLDER, type ReceiptExportOptions, type ReceiptExportPlan } from './receipt-files'
import { zipReadableStream, type ZipEntry } from './zip'

const PAGE = 2000

/** Keys never exported, at any depth (bank and integration credentials, tokens, password hashes). */
const SECRET_KEY = /token|secret|credential|password|encrypted|apikey|api_key/i

/** JSON of `value` without secret keys; Decimals as strings, dates as ISO strings. */
export function exportJson(value: unknown): string {
  return JSON.stringify(
    value,
    (key, item: unknown) => {
      if (key && SECRET_KEY.test(key)) return undefined
      if (typeof item === 'bigint') return item.toString()
      if (item && typeof item === 'object' && 'toFixed' in item && typeof (item as { toFixed: unknown }).toFixed === 'function' && !(item instanceof Number)) {
        return (item as { toString(): string }).toString()
      }
      return item
    },
    2,
  )
}

/** Every row of a paged query, ordered by id. */
async function allPages<T extends { id: string }>(page: (cursor: string | undefined) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = []
  let cursor: string | undefined
  for (;;) {
    const batch = await page(cursor)
    rows.push(...batch)
    if (batch.length < PAGE) return rows
    cursor = batch[batch.length - 1].id
  }
}

const paged = (cursor: string | undefined) => ({ take: PAGE, orderBy: { id: 'asc' as const }, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })

type TableLoader = (companyId: string) => Promise<unknown>

/** The JSON files of the archive, in order: name, then how to read it. */
const TABLES: Array<[string, TableLoader]> = [
  ['societe', (companyId) => prisma.company.findUnique({ where: { id: companyId } })],
  ['adresses', (companyId) => prisma.address.findMany({ where: { companyId }, orderBy: { id: 'asc' } })],
  ['etablissements', (companyId) => prisma.establishment.findMany({ where: { companyId }, orderBy: { id: 'asc' } })],
  ['associes', (companyId) => prisma.shareholder.findMany({ where: { companyId }, orderBy: { id: 'asc' } })],
  ['personnes', (companyId) => prisma.person.findMany({ where: { companyId }, orderBy: { id: 'asc' } })],
  ['regimes-fiscaux', (companyId) => prisma.taxRegimeHistory.findMany({ where: { companyId }, orderBy: { id: 'asc' } })],
  ['exercices', (companyId) => prisma.fiscalYear.findMany({ where: { companyId }, orderBy: { startDate: 'asc' } })],
  ['journaux', (companyId) => prisma.journal.findMany({ where: { companyId }, orderBy: { code: 'asc' } })],
  ['comptes', (companyId) => allPages((cursor) => prisma.account.findMany({ where: { companyId }, ...paged(cursor) }))],
  [
    'ecritures',
    (companyId) =>
      allPages((cursor) => prisma.accountingEntry.findMany({ where: { companyId }, include: { lines: { orderBy: { id: 'asc' } } }, ...paged(cursor) })),
  ],
  [
    'banque-connexions',
    (companyId) =>
      prisma.bankConnection.findMany({
        where: { companyId },
        orderBy: { id: 'asc' },
        // Only what identifies the connection: its credentials stay in Kledg.
        select: { id: true, provider: true, status: true, lastSyncAt: true, createdAt: true },
      }),
  ],
  ['banque-comptes', (companyId) => prisma.bankAccount.findMany({ where: { bankConnection: { companyId } }, orderBy: { id: 'asc' } })],
  [
    'banque-transactions',
    (companyId) =>
      allPages((cursor) =>
        prisma.bankTransaction.findMany({ where: { bankAccount: { bankConnection: { companyId } } }, ...paged(cursor) }),
      ),
  ],
  ['immobilisations', (companyId) => prisma.fixedAsset.findMany({ where: { companyId }, include: { depreciations: true }, orderBy: { id: 'asc' } })],
  ['tiers', (companyId) => allPages((cursor) => prisma.tiers.findMany({ where: { companyId }, ...paged(cursor) }))],
  [
    'factures',
    (companyId) =>
      allPages((cursor) => prisma.invoice.findMany({ where: { companyId }, include: { lines: true, vatBreakdown: true, payments: true }, ...paged(cursor) })),
  ],
  [
    'regles-affectation',
    (companyId) => prisma.transactionRule.findMany({ where: { companyId }, include: { conditions: true, entryLines: true }, orderBy: { id: 'asc' } }),
  ],
  ['pieces-justificatives', (companyId) => allPages((cursor) => prisma.attachment.findMany({ where: { companyId }, ...paged(cursor) }))],
]

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')}\u00a0Go`

function receiptsReadme(plan: ReceiptExportPlan): string {
  if (plan.files === 0) return ''
  const common = `  manifeste.csv (et manifeste.json) relie chaque fichier à ce qu'il justifie :
  transaction bancaire (date, libellé, montant), ligne de note de frais
  (numéro de la note, date, montant TTC) ou justificatif en attente, avec
  l'empreinte SHA-256 et le statut de chaque fichier.`
  if (plan.embedded) {
    return `
${RECEIPTS_FOLDER}/
  Les justificatifs conservés par Kledg (photos, PDF), nommés
  <date>_<nom> : la date de la transaction ou de la dépense justifiée.
  Chaque fichier est vérifié par son empreinte SHA-256 avant d'être ajouté ;
  un fichier introuvable ou altéré n'est pas ajouté et le manifeste l'indique.
${common}
`
  }
  return `
${RECEIPTS_FOLDER}/
  Vos ${plan.files} justificatifs représentent ${gib(plan.bytes)}, au-delà de ce qu'un
  export en ligne peut contenir : ils ne sont pas dans cette archive et
  vous sont remis sur demande : contactez le support de Kledg Cloud.
${common}
`
}

const README = (companyName: string, exportedAt: Date, receipts: ReceiptExportPlan) => `Export complet des données de ${companyName}
Généré le ${exportedAt.toISOString()} par Kledg Cloud.

fec/
  Le fichier des écritures comptables (FEC) de chaque exercice, au format
  défini par l'article A47 A-1 du livre des procédures fiscales. Il s'importe
  dans tout logiciel de comptabilité français.

donnees/
  Toutes les données de la société au format JSON, une table par fichier :
  société, adresses, établissements, associés, personnes, régimes fiscaux,
  exercices, journaux, plan de comptes, écritures (avec leurs lignes),
  connexions et comptes bancaires, transactions, immobilisations, tiers,
  factures, règles d'affectation, pièces justificatives (métadonnées).
  Les montants sont des chaînes décimales, les dates au format ISO 8601.
  Les identifiants de connexion bancaire et autres secrets ne sont jamais
  exportés.
${receiptsReadme(receipts)}`

/** The entries of the archive of one company, built one after the other. */
export async function* companyExportEntries(companyId: string, now: Date = new Date(), receipts: ReceiptExportOptions = {}): AsyncGenerator<ZipEntry> {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } })
  const plan = await planReceiptExport(companyId, receipts.maxBytes)
  yield { name: 'LISEZMOI.txt', data: README(company.name, now, plan) }

  const fiscalYears = await prisma.fiscalYear.findMany({ where: { companyId }, orderBy: { startDate: 'asc' }, select: { id: true } })
  for (const fiscalYear of fiscalYears) {
    const fec = await exportFec(companyId, fiscalYear.id)
    yield { name: `fec/${fec.fileName}`, data: fec.content }
  }

  for (const [name, load] of TABLES) {
    yield { name: `donnees/${name}.json`, data: exportJson(await load(companyId)) }
  }

  yield* receiptFileEntries(companyId, plan, receipts)
}

/** File name of the archive: kledg-export-<slug>-<yyyy-mm-dd>.zip. */
export function exportFileName(slug: string, now: Date = new Date()): string {
  return `kledg-export-${slug.replace(/[^a-z0-9-]/gi, '') || 'societe'}-${now.toISOString().slice(0, 10)}.zip`
}

/** Companies whose full export `userId` may download: those they administer (their own, or as company administrator). */
export async function exportableCompanies(userId: string): Promise<Array<{ id: string; slug: string; name: string }>> {
  const members = await prisma.member.findMany({
    where: { userId, role: { contains: 'companyAdmin' } },
    select: { organization: { select: { company: { select: { id: true, slug: true, name: true } } } } },
    take: 500,
  })
  return members
    .flatMap((m) => (m.organization.company ? [m.organization.company] : []))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
}

/** The streamed archive of one company and its file name; the export is written to the audit log. */
export async function companyExportArchive(companyId: string, userId: string, now: Date = new Date()): Promise<{ fileName: string; stream: ReadableStream<Uint8Array> }> {
  const { slug } = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { slug: true } })
  await writeAuditLog('info', 'Full data export', { action: 'CLOUD_DATA_EXPORT', companyId, metadata: { userId } })
  // The archive is read after the route returned: each step runs again in the request's context.
  const context = currentRlsContext()
  const within = <T>(step: () => T): T => (context ? runWithRlsContext(context, step) : step())
  return { fileName: exportFileName(slug, now), stream: zipReadableStream(companyExportEntries(companyId, now), now, within) }
}

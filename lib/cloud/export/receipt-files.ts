/**
 * The receipt files of a company in its full export (lib/cloud/export,
 * docs/cloud.md#data-export): the bytes Kledg keeps for it (receipt_files,
 * wherever they live: PostgreSQL, Vercel Blob, S3, a directory), so a client
 * gets their stored receipts back, not only their metadata.
 *
 * - One archive entry per file, `justificatifs/<yyyy-mm-dd>_<name>`: the
 *   date of the bank transaction or expense line it justifies (else the
 *   receipt's own date, else when it was kept), the name it was given;
 *   names are made unique with -2, -3...
 * - Each file is read through the core receipt file store
 *   (readReceiptFileBytes): from its own driver, checked against its size
 *   and SHA-256 like every read of Kledg. A file missing from the storage or
 *   altered is not exported; the manifest says so and the export goes on.
 * - `justificatifs/manifeste.csv` and `manifeste.json` map each file to what
 *   it justifies: bank transaction, expense line (and its report), receipt
 *   waiting to be filed. One row per link, a row without link for a file
 *   nothing refers to.
 * - Streamed: files are listed in pages without their bytes, then read one
 *   at a time, stored without deflate (photos and PDFs are compressed
 *   already). Only one file and the manifest rows are in memory.
 * - Size cap: the ZIP writer has no ZIP64 (4 GiB). When the company's files
 *   add up to more than MAX_EMBEDDED_RECEIPT_BYTES, no file is embedded:
 *   the manifest still lists every one, with the status "non inclus", and
 *   the files are delivered another way (docs/cloud.md).
 */

import { prisma } from '@/lib/prisma'
import { logger } from '@/lib/logger'
import { NotFoundError } from '@/lib/accounting/errors'
import { readReceiptFileBytes, RECEIPT_FILE_SELECT, type ReceiptFileRow } from '@/lib/receipts/receipt-file-store'
import type { ZipEntry } from './zip'

export const RECEIPTS_FOLDER = 'justificatifs'

/** Above this total, receipt files are listed in the manifest but not embedded (no ZIP64, function duration). */
export const MAX_EMBEDDED_RECEIPT_BYTES = 2 * 1024 * 1024 * 1024

const PAGE = 200
const MAX_NAME_LENGTH = 120

const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/gif': 'gif',
}

export type ReceiptExportStatus = 'inclus' | 'introuvable' | 'illisible' | 'non inclus'

/** One row of the manifest: a file and one thing it justifies. */
export interface ReceiptManifestRow {
  /** Path in the archive (also when the file is not embedded: the name it would have). */
  fichier: string
  statut: ReceiptExportStatus
  sha256: string
  taille: number
  type: string
  stockage: string
  lien: 'transaction bancaire' | 'ligne de note de frais' | 'justificatif en attente' | 'aucun'
  pieceId: string | null
  transactionId: string | null
  transactionDate: string | null
  transactionLibelle: string | null
  transactionMontant: string | null
  transactionSens: string | null
  noteDeFraisId: string | null
  noteDeFraisNumero: string | null
  ligneNoteDeFraisId: string | null
  ligneDate: string | null
  ligneLibelle: string | null
  ligneMontantTTC: string | null
  justificatifEnAttenteId: string | null
  justificatifStatut: string | null
}

const FILE_LIST_SELECT = {
  id: true,
  sha256: true,
  size: true,
  contentType: true,
  storageDriver: true,
  createdAt: true,
  attachments: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      fileName: true,
      bankTransaction: { select: { id: true, date: true, label: true, amount: true, side: true } },
      expenseLines: {
        orderBy: { date: 'asc' },
        select: { id: true, date: true, label: true, amountInclTax: true, report: { select: { id: true, number: true } } },
      },
    },
  },
  stagedReceipts: {
    orderBy: { createdAt: 'asc' },
    select: { id: true, fileName: true, status: true, receiptDate: true, bankTransactionId: true, expenseReportId: true, expenseLineId: true },
  },
} as const

type ListedFile = Awaited<ReturnType<typeof listPage>>[number]

function listPage(companyId: string, cursor: string | undefined) {
  return prisma.receiptFile.findMany({
    where: { companyId },
    select: FILE_LIST_SELECT,
    take: PAGE,
    orderBy: { id: 'asc' },
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  })
}

const day = (date: Date | null | undefined) => (date ? date.toISOString().slice(0, 10) : null)
const text = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : value.toString())

/** A file name safe on every system: no path, no control or reserved characters, bounded length, with its extension. */
export function safeReceiptName(name: string | null | undefined, contentType: string): string {
  const extension = EXTENSIONS[contentType] ?? 'bin'
  let clean = (name ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .trim()
  if (!clean) clean = `justificatif.${extension}`
  if (!/\.[A-Za-z0-9]{1,5}$/.test(clean)) clean = `${clean}.${extension}`
  if (clean.length > MAX_NAME_LENGTH) {
    const dot = clean.lastIndexOf('.')
    const ext = clean.slice(dot)
    clean = clean.slice(0, MAX_NAME_LENGTH - ext.length).trimEnd() + ext
  }
  return clean
}

/** The date a file is filed under: what it justifies first, else its own date, else when Kledg kept it. */
function fileDate(file: ListedFile): Date {
  for (const attachment of file.attachments) {
    if (attachment.bankTransaction) return attachment.bankTransaction.date
    if (attachment.expenseLines[0]) return attachment.expenseLines[0].date
  }
  return file.stagedReceipts.find((s) => s.receiptDate)?.receiptDate ?? file.createdAt
}

function fileName(file: ListedFile): string | null {
  return file.attachments[0]?.fileName ?? file.stagedReceipts[0]?.fileName ?? null
}

/** `name`, or `name-2`, `name-3`... the first one not used yet in the archive. */
function unique(path: string, used: Set<string>): string {
  let candidate = path
  const dot = path.lastIndexOf('.')
  const [stem, ext] = dot > path.lastIndexOf('/') ? [path.slice(0, dot), path.slice(dot)] : [path, '']
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem}-${n}${ext}`
  used.add(candidate.toLowerCase())
  return candidate
}

const EMPTY_LINK = {
  pieceId: null,
  transactionId: null,
  transactionDate: null,
  transactionLibelle: null,
  transactionMontant: null,
  transactionSens: null,
  noteDeFraisId: null,
  noteDeFraisNumero: null,
  ligneNoteDeFraisId: null,
  ligneDate: null,
  ligneLibelle: null,
  ligneMontantTTC: null,
  justificatifEnAttenteId: null,
  justificatifStatut: null,
} as const

/** The manifest rows of one file: one per bank transaction, expense line and waiting receipt it is linked to. */
function manifestRows(file: ListedFile, path: string, statut: ReceiptExportStatus): ReceiptManifestRow[] {
  const base = { fichier: path, statut, sha256: file.sha256, taille: file.size, type: file.contentType, stockage: file.storageDriver }
  const rows: ReceiptManifestRow[] = []
  for (const attachment of file.attachments) {
    const t = attachment.bankTransaction
    if (t) {
      rows.push({
        ...base,
        ...EMPTY_LINK,
        lien: 'transaction bancaire',
        pieceId: attachment.id,
        transactionId: t.id,
        transactionDate: day(t.date),
        transactionLibelle: t.label,
        transactionMontant: text(t.amount),
        transactionSens: t.side,
      })
    }
    for (const line of attachment.expenseLines) {
      rows.push({
        ...base,
        ...EMPTY_LINK,
        lien: 'ligne de note de frais',
        pieceId: attachment.id,
        noteDeFraisId: line.report.id,
        noteDeFraisNumero: line.report.number,
        ligneNoteDeFraisId: line.id,
        ligneDate: day(line.date),
        ligneLibelle: line.label,
        ligneMontantTTC: text(line.amountInclTax),
      })
    }
  }
  // Receipts waiting to be filed; one already attached or turned into an expense is listed through its attachment.
  const linked = rows.length > 0
  for (const staged of file.stagedReceipts) {
    if (staged.status !== 'staged' && linked) continue
    rows.push({
      ...base,
      ...EMPTY_LINK,
      lien: 'justificatif en attente',
      justificatifEnAttenteId: staged.id,
      justificatifStatut: staged.status,
      transactionId: staged.bankTransactionId,
      noteDeFraisId: staged.expenseReportId,
      ligneNoteDeFraisId: staged.expenseLineId,
    })
  }
  if (rows.length === 0) rows.push({ ...base, ...EMPTY_LINK, lien: 'aucun' })
  return rows
}

const MANIFEST_COLUMNS: Array<keyof ReceiptManifestRow> = [
  'fichier',
  'statut',
  'lien',
  'transactionId',
  'transactionDate',
  'transactionLibelle',
  'transactionMontant',
  'transactionSens',
  'noteDeFraisId',
  'noteDeFraisNumero',
  'ligneNoteDeFraisId',
  'ligneDate',
  'ligneLibelle',
  'ligneMontantTTC',
  'justificatifEnAttenteId',
  'justificatifStatut',
  'pieceId',
  'sha256',
  'taille',
  'type',
  'stockage',
]

/** CSV of the manifest: semicolons and a UTF-8 BOM, as French spreadsheets open it. */
export function manifestCsv(rows: ReceiptManifestRow[]): string {
  const cell = (value: unknown) => {
    const s = value === null || value === undefined ? '' : String(value)
    return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [MANIFEST_COLUMNS.join(';'), ...rows.map((row) => MANIFEST_COLUMNS.map((c) => cell(row[c])).join(';'))]
  return `﻿${lines.join('\r\n')}\r\n`
}

export interface ReceiptExportOptions {
  maxBytes?: number
  /** Reads a file's bytes, checked (tests replace it to count reads). */
  read?: (row: ReceiptFileRow) => Promise<Uint8Array>
}

/** Summary of the receipts part, for the archive's LISEZMOI. */
export interface ReceiptExportPlan {
  files: number
  bytes: number
  embedded: boolean
}

export async function planReceiptExport(companyId: string, maxBytes: number = MAX_EMBEDDED_RECEIPT_BYTES): Promise<ReceiptExportPlan> {
  const total = await prisma.receiptFile.aggregate({ where: { companyId }, _count: { _all: true }, _sum: { size: true } })
  const bytes = total._sum.size ?? 0
  return { files: total._count._all, bytes, embedded: bytes <= maxBytes }
}

/**
 * The archive entries of the company's receipt files, then the manifest.
 * Nothing when the company keeps no file.
 */
export async function* receiptFileEntries(companyId: string, plan: ReceiptExportPlan, options: ReceiptExportOptions = {}): AsyncGenerator<ZipEntry> {
  if (plan.files === 0) return
  const read = options.read ?? readReceiptFileBytes
  const used = new Set<string>(['manifeste.csv', 'manifeste.json'].map((n) => `${RECEIPTS_FOLDER}/${n}`))
  const manifest: ReceiptManifestRow[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await listPage(companyId, cursor)
    for (const file of page) {
      const path = unique(`${RECEIPTS_FOLDER}/${day(fileDate(file))}_${safeReceiptName(fileName(file), file.contentType)}`, used)
      let statut: ReceiptExportStatus = 'non inclus'
      if (plan.embedded) {
        try {
          // The bytes of this file only (postgres rows carry them), read and verified by the core store.
          const row = await prisma.receiptFile.findUniqueOrThrow({ where: { id: file.id }, select: RECEIPT_FILE_SELECT })
          const bytes = await read(row)
          yield { name: path, data: bytes, store: true }
          statut = 'inclus'
        } catch (error) {
          statut = error instanceof NotFoundError ? 'introuvable' : 'illisible'
          logger.error('[Cloud export] Receipt file left out of the export', {
            companyId,
            fileId: file.id,
            driver: file.storageDriver,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      manifest.push(...manifestRows(file, path, statut))
    }
    if (page.length < PAGE) break
    cursor = page[page.length - 1].id
  }
  yield { name: `${RECEIPTS_FOLDER}/manifeste.csv`, data: manifestCsv(manifest) }
  yield { name: `${RECEIPTS_FOLDER}/manifeste.json`, data: JSON.stringify(manifest, null, 2) }
}

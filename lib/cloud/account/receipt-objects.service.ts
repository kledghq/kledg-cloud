/**
 * Deletion of the stored receipt objects of purged companies (Kledg Cloud,
 * docs/cloud.md, Data, GDPR and retention; CGV art. 14, DPA art. 10).
 *
 * Kledg Cloud is the processor of the books: at the end of the service it
 * deletes all the client's data (RGPD art. 28(3)(g)), receipt files
 * included, once the export window is over. Keeping the books and their
 * supporting documents (10 years, Code de commerce art. L123-22; 6 years
 * for the tax administration, LPF art. L102 B) is the client company's
 * duty, through its export.
 *
 * Order, so that no row ever points to a deleted object:
 * 1. in the purge transaction (purgeCompanies), the keys of the companies'
 *    receipt files (companyReceiptObjects) and, for the Vercel Blob store,
 *    one prefix per company (receipts/<companyId>/, to catch objects no row
 *    knows: an upload whose row was never created and whose cleanup
 *    failed) are written to cloud_pending_object_deletions, then the
 *    companies and their rows are deleted;
 * 2. after the commit, each pending object is deleted (discardObjects, the
 *    core helper, which logs a failure) and checked gone (`exists`); each
 *    prefix is listed and emptied the same way. A pending row is removed
 *    once its object or prefix is gone; otherwise it records the attempt
 *    and the maintenance job retries it on its next runs
 *    (retryPendingObjectDeletions).
 */

import * as blobSdk from '@vercel/blob'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { logger } from '@/lib/logger'
import { writeAuditLog } from '@/lib/audit'
import { configuredStorageDriver, objectStorage, type ObjectStorageDriver } from '@/lib/storage'
import { RECEIPT_OBJECT_NAMESPACE, companyReceiptObjects, discardObjects } from '@/lib/receipts/receipt-file-store'

type Tx = Prisma.TransactionClient

export interface PendingDeletion {
  id: string
  kind: string
  storageDriver: string
  target: string
}

export interface ObjectDeletionOutcome {
  /** Objects deleted from the object storage. */
  deleted: number
  /** Pending rows left (objects or prefixes still there, retried by the maintenance job). */
  pending: number
}

/** Lists the keys under a prefix of a driver that can list (Vercel Blob). Replaced by a fake in the tests. */
export interface PrefixLister {
  keys(prefix: string): Promise<string[]>
}

const blobLister: PrefixLister = {
  async keys(prefix) {
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const page = await blobSdk.list({ prefix, cursor, limit: 1000, mode: 'expanded' })
      keys.push(...page.blobs.map((blob) => blob.pathname))
      cursor = page.hasMore ? page.cursor : undefined
    } while (cursor)
    return keys
  },
}

let listerForTests: PrefixLister | null = null

/** Test hook: a fake listing of the Blob store. */
export function setPrefixListerForTests(lister: PrefixLister | null): void {
  listerForTests = lister
}

function listerOf(driver: string): PrefixLister | null {
  if (driver !== 'blob') return null
  return listerForTests ?? blobLister
}

export const companyObjectPrefix = (companyId: string) => `${RECEIPT_OBJECT_NAMESPACE}/${companyId}/`

/**
 * Inside the purge transaction, before the companies are deleted: records
 * what must leave the object storage once the rows are gone. Returns the
 * pending rows to delete after the commit.
 */
export async function recordCompanyObjects(tx: Tx, companyIds: string[]): Promise<PendingDeletion[]> {
  const data: Array<{ kind: string; storageDriver: string; target: string }> = []
  const drivers = new Set<string>()
  for (const companyId of companyIds) {
    for (const { storageDriver, storageKey } of await companyReceiptObjects(companyId, tx)) {
      if (storageDriver === 'postgres' || !storageKey) continue
      drivers.add(storageDriver)
      data.push({ kind: 'object', storageDriver, target: storageKey })
    }
  }
  // The Blob store can be listed: sweep each company's prefix too.
  if (configuredStorageDriver() === 'blob') drivers.add('blob')
  for (const driver of drivers) {
    if (!listerOf(driver)) continue
    for (const companyId of companyIds) data.push({ kind: 'prefix', storageDriver: driver, target: companyObjectPrefix(companyId) })
  }
  if (data.length === 0) return []
  await tx.cloudPendingObjectDeletion.createMany({ data, skipDuplicates: true })
  return tx.cloudPendingObjectDeletion.findMany({
    where: { OR: data.map(({ storageDriver, target }) => ({ storageDriver, target })) },
    select: { id: true, kind: true, storageDriver: true, target: true },
  })
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500)

/** Deletes one object and tells whether it is gone (a failed check counts as still there). */
async function deleteObject(driver: string, key: string): Promise<boolean> {
  await discardObjects([{ storageDriver: driver, storageKey: key }])
  return !(await objectStorage(driver as ObjectStorageDriver).exists(key))
}

/** Deletes what one pending row names. Returns the number of objects deleted, and whether everything is gone. */
async function runOne(row: PendingDeletion): Promise<{ deleted: number; done: boolean }> {
  if (row.kind === 'object') {
    const gone = await deleteObject(row.storageDriver, row.target)
    return { deleted: gone ? 1 : 0, done: gone }
  }
  const lister = listerOf(row.storageDriver)
  if (!lister) return { deleted: 0, done: true }
  let deleted = 0
  for (const key of await lister.keys(row.target)) {
    if (!key.startsWith(row.target)) continue
    if (await deleteObject(row.storageDriver, key)) deleted += 1
  }
  return { deleted, done: (await lister.keys(row.target)).length === 0 }
}

/**
 * After the commit of a purge, or from the maintenance job: deletes the
 * objects of the pending rows given, objects before prefixes (a prefix
 * listing then finds only what no row knew). Never throws.
 */
export async function deletePendingObjects(rows: PendingDeletion[], now: Date = new Date()): Promise<ObjectDeletionOutcome> {
  let deleted = 0
  let pending = 0
  const ordered = [...rows].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'object' ? -1 : 1))
  for (const row of ordered) {
    let outcome: { deleted: number; done: boolean }
    let failure: string | null = null
    try {
      outcome = await runOne(row)
    } catch (error) {
      outcome = { deleted: 0, done: false }
      failure = messageOf(error)
    }
    deleted += outcome.deleted
    try {
      if (outcome.done) {
        await prisma.cloudPendingObjectDeletion.deleteMany({ where: { id: row.id } })
      } else {
        pending += 1
        await prisma.cloudPendingObjectDeletion.update({
          where: { id: row.id },
          data: { attempts: { increment: 1 }, lastAttemptAt: now, lastError: failure ?? 'Object still in the storage after its deletion' },
        })
        logger.error('[Cloud] Stored object of a purged company not deleted yet, retried by the maintenance job', {
          pendingId: row.id,
          kind: row.kind,
          driver: row.storageDriver,
          error: failure,
        })
      }
    } catch (error) {
      logger.error('[Cloud] Could not record the outcome of a stored object deletion', { pendingId: row.id, error: messageOf(error) })
    }
  }
  return { deleted, pending }
}

/** Maintenance: retries the pending deletions (oldest first, a bounded batch per run). */
export async function retryPendingObjectDeletions(now: Date = new Date()): Promise<ObjectDeletionOutcome> {
  const rows = await prisma.cloudPendingObjectDeletion.findMany({
    select: { id: true, kind: true, storageDriver: true, target: true },
    orderBy: { createdAt: 'asc' },
    take: 500,
  })
  if (rows.length === 0) return { deleted: 0, pending: 0 }
  const outcome = await deletePendingObjects(rows, now)
  if (outcome.deleted > 0) {
    await writeAuditLog('warn', 'Stored objects of purged companies deleted', {
      action: 'CLOUD_RECEIPT_OBJECTS_DELETED',
      metadata: { deletedReceiptObjects: outcome.deleted, pendingReceiptObjects: outcome.pending },
    })
  }
  return outcome
}

/**
 * Acceptances of the CGV (versions in lib/cloud/legal/terms.ts),
 * kept as evidence: user, document, version and date. A new version is
 * accepted again from the banner of the application frame.
 */

import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { enforceRateLimit } from '@/lib/rate-limit'
import { ConflictError } from '@/lib/accounting/errors'
import type { CurrentUser } from '@/lib/session'
import { CURRENT_TERMS, currentTermsVersion, TERMS_DOCUMENTS, type TermsDocument } from './terms'
import { z } from 'zod'

type Db = Prisma.TransactionClient | typeof prisma

/** Records the acceptance of the current version of every document (idempotent). */
export async function recordTermsAcceptance(userId: string, now: Date = new Date(), db: Db = prisma): Promise<void> {
  await db.cloudTermsAcceptance.createMany({
    data: TERMS_DOCUMENTS.map((document) => ({ userId, document, version: CURRENT_TERMS[document].version, acceptedAt: now })),
    skipDuplicates: true,
  })
}

/** Documents whose current version `userId` has not accepted yet. */
export async function pendingTerms(userId: string): Promise<TermsDocument[]> {
  const accepted = await prisma.cloudTermsAcceptance.findMany({
    where: { userId, OR: TERMS_DOCUMENTS.map((document) => ({ document, version: CURRENT_TERMS[document].version })) },
    select: { document: true },
  })
  const done = new Set(accepted.map((row) => row.document))
  return TERMS_DOCUMENTS.filter((document) => !done.has(document))
}

export const AcceptTermsSchema = z.object({
  version: z.string({ error: 'Version des conditions manquante.' }).max(200),
})

/** Acceptance from the banner: the version shown must still be the current one. */
export async function acceptCurrentTerms(user: CurrentUser, input: z.infer<typeof AcceptTermsSchema>): Promise<{ accepted: true }> {
  await enforceRateLimit('cloud-terms', user.id)
  if (input.version !== currentTermsVersion()) {
    throw new ConflictError('Les conditions ont changé entre-temps. Rechargez la page pour lire la nouvelle version.')
  }
  await recordTermsAcceptance(user.id)
  return { accepted: true }
}

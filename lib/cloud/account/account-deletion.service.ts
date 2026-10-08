/**
 * Account deletion in Kledg Cloud (RGPD art. 17; CGV art. 14 and 15).
 *
 * Two ways in, one way out:
 * - Requested by the owner (page "Données et compte"): address and password
 *   confirmed, and, when the account's companies hold books (validated
 *   entries or a closed fiscal year), an explicit acknowledgement that the
 *   books will be deleted and that keeping them 10 years is the company's
 *   duty (Code de commerce art. L123-22), with the export at hand. The
 *   account turns read-only for 30 days, during which the deletion can be
 *   cancelled and everything exported; the subscription is set to end with
 *   its period; an email confirms the date.
 * - Contract ended (trial ended without a card, subscription cancelled or
 *   unpaid until Stripe ended it): the maintenance job sends the end notice
 *   with the date of the end of the read-only retrieval period (30 days) and
 *   schedules the deletion for that date (maintenance.service.ts).
 *
 * Execution (maintenance job, once the date is reached, so within the 30
 * days the CGV allow): the subscription is cancelled if still live, every
 * company the account owns is deleted with its books, then the user,
 * sessions, credentials, API keys, terms acceptances and billing account.
 * The stored objects of the companies' receipt files are deleted after
 * the rows (purgeCompanies, receipt-objects.service.ts). A confirmation
 * email goes to the former address. Kledg keeps only what the law requires
 * of it: its own invoices, kept by Stripe. Keeping the books and receipts
 * is the client company's duty (10 years, Code de commerce art. L123-22; 6
 * years for the tax administration, LPF art. L102 B), through the full
 * export of the retrieval period.
 *
 * An account that is the last administrator of a company it does not own
 * cannot be deleted until another administrator is named there (Kledg's
 * guard, lib/account/deletion-guards.ts).
 */

import type Stripe from 'stripe'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { sendEmail } from '@/lib/email'
import { getAppUrl } from '@/lib/config'
import { logger } from '@/lib/logger'
import { writeAuditLog } from '@/lib/audit'
import { enforceRateLimit } from '@/lib/rate-limit'
import { ConflictError, ValidationError } from '@/lib/accounting/errors'
import { companyHasBooks } from '@/lib/companies/archive-company.service'
import { checkAccountDeletion } from '@/lib/account/deletion-guards'
import type { CurrentUser } from '@/lib/session'
import { CLOUD_PATHS, cloudSettings, LEGAL_URLS } from '../config'
import { accountDeletedEmail, deletionScheduledEmail } from '../email-templates'
import { ensureBillingAccount, findBillingAccount, ownedCompanyIds } from '../billing/billing-account.service'
import { addDays, hasLiveSubscription } from '../billing/state'
import { getStripe } from '../billing/stripe'
import { deletePendingObjects, recordCompanyObjects } from './receipt-objects.service'

export interface DeletionCompany {
  id: string
  name: string
  hasBooks: boolean
}

export interface DeletionPreview {
  scheduledFor: string | null
  reason: 'requested' | 'contract_ended' | null
  deletionDays: number
  companies: DeletionCompany[]
  /** Reasons the account cannot be scheduled for deletion now (French). */
  blockers: string[]
}

/** The owned companies, with whether they hold books. */
async function ownedCompanies(billingAccountId: string): Promise<DeletionCompany[]> {
  const ids = await ownedCompanyIds(billingAccountId)
  if (ids.length === 0) return []
  const companies = await prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
  return Promise.all(companies.map(async (company) => ({ ...company, hasBooks: await companyHasBooks(company.id) })))
}

/** Companies the user administers without owning them, where nobody else could take over. */
async function blockersOf(user: { id: string; role: string | null }, owned: Set<string>): Promise<string[]> {
  if (user.role === 'admin') return ["Le compte de l'opérateur ne se supprime pas depuis cette page."]
  const { companies } = await checkAccountDeletion({ id: user.id, role: user.role })
  const stuck = companies.filter((company) => company.lastCompanyAdmin && !owned.has(company.id)).map((company) => company.name)
  if (stuck.length === 0) return []
  const one = stuck.length === 1
  return [
    `Vous êtes le seul administrateur de ${one ? 'la société' : 'des sociétés'} ${stuck.join(', ')}, qui ne vous ${one ? 'appartient' : 'appartiennent'} pas. Demandez à son titulaire de nommer un autre administrateur avant de supprimer votre compte.`,
  ]
}

const reasonOf = (value: string | null): DeletionPreview['reason'] => (value === 'requested' || value === 'contract_ended' ? value : null)

export async function previewAccountDeletion(user: CurrentUser): Promise<DeletionPreview> {
  const account = await findBillingAccount(user.id)
  const companies = account ? await ownedCompanies(account.id) : []
  return {
    scheduledFor: account?.deletionScheduledFor?.toISOString() ?? null,
    reason: reasonOf(account?.deletionReason ?? null),
    deletionDays: cloudSettings().deletionDays,
    companies,
    blockers: await blockersOf(user, new Set(companies.map((c) => c.id))),
  }
}

export const ScheduleDeletionSchema = z.object({
  email: z.string({ error: 'Saisissez votre adresse email.' }).trim().toLowerCase().max(254),
  password: z.string({ error: 'Saisissez votre mot de passe.' }).min(1, 'Saisissez votre mot de passe.').max(128),
  /** The owner read that the books will be deleted and that keeping them is the company's duty. */
  acknowledgeBooksDeletion: z.boolean().default(false),
})
export type ScheduleDeletionInput = z.infer<typeof ScheduleDeletionSchema>

export const BOOKS_ACKNOWLEDGEMENT_MESSAGE =
  'Confirmez que vous avez exporté vos livres comptables : ils seront supprimés définitivement avec votre compte, justificatifs compris, et votre société doit conserver ses livres et ses pièces justificatives 10 ans (Code de commerce art. L123-22).'

async function verifyPassword(userId: string, password: string): Promise<boolean> {
  const credential = await prisma.authAccount.findFirst({ where: { userId, providerId: 'credential' }, select: { password: true } })
  if (!credential?.password) return false
  const context = await auth.$context
  return context.password.verify({ hash: credential.password, password })
}

export async function scheduleAccountDeletion(
  user: CurrentUser,
  input: ScheduleDeletionInput,
  options: { now?: Date; stripe?: () => Stripe } = {},
): Promise<DeletionPreview> {
  const now = options.now ?? new Date()
  await enforceRateLimit('cloud-account-deletion', user.id)
  if (input.email !== user.email.toLowerCase()) throw new ValidationError("L'adresse saisie ne correspond pas à celle de votre compte.")
  if (!(await verifyPassword(user.id, input.password))) throw new ValidationError('Mot de passe incorrect. Saisissez le mot de passe de votre compte.')

  const account = await ensureBillingAccount(user.id)
  if (account.deletionScheduledFor) throw new ConflictError('La suppression de votre compte est déjà programmée.')
  const companies = await ownedCompanies(account.id)
  const blockers = await blockersOf(user, new Set(companies.map((c) => c.id)))
  if (blockers.length > 0) throw new ConflictError(blockers.join(' '))
  if (companies.some((c) => c.hasBooks) && !input.acknowledgeBooksDeletion) throw new ValidationError(BOOKS_ACKNOWLEDGEMENT_MESSAGE)

  const scheduledFor = addDays(now, cloudSettings().deletionDays)
  await prisma.cloudBillingAccount.update({
    where: { id: account.id },
    data: { deletionRequestedAt: now, deletionScheduledFor: scheduledFor, deletionReason: 'requested' },
  })

  // No renewal during the 30 days: the subscription ends with its period.
  if (account.stripeSubscriptionId && hasLiveSubscription(account.subscriptionStatus)) {
    try {
      await (options.stripe ?? getStripe)().subscriptions.update(account.stripeSubscriptionId, { cancel_at_period_end: true })
    } catch (error) {
      logger.error('Could not stop the renewal of a subscription before an account deletion', { error, billingAccountId: account.id })
    }
  }

  await writeAuditLog('warn', 'Account deletion scheduled', {
    action: 'CLOUD_ACCOUNT_DELETION_SCHEDULED',
    metadata: { userId: user.id, scheduledFor: scheduledFor.toISOString(), companiesWithBooks: companies.filter((c) => c.hasBooks).length },
  })
  await sendEmail(deletionScheduledEmail(user.email, scheduledFor, `${getAppUrl()}${CLOUD_PATHS.data}`)).catch((error: unknown) =>
    logger.error('Deletion confirmation email failed', { error }),
  )
  return previewAccountDeletion(user)
}

/** Cancels a deletion the owner requested (a deletion after the end of the contract ends by subscribing again). */
export async function cancelAccountDeletion(user: CurrentUser): Promise<DeletionPreview> {
  await enforceRateLimit('cloud-account-deletion', user.id)
  const account = await findBillingAccount(user.id)
  if (!account?.deletionScheduledFor) throw new ConflictError("Aucune suppression n'est programmée pour votre compte.")
  if (account.deletionReason !== 'requested') {
    throw new ConflictError('Votre abonnement a pris fin : choisissez une offre depuis la page Facturation pour conserver votre compte.')
  }
  await prisma.cloudBillingAccount.update({ where: { id: account.id }, data: { deletionRequestedAt: null, deletionScheduledFor: null, deletionReason: null } })
  await writeAuditLog('info', 'Account deletion cancelled', { action: 'CLOUD_ACCOUNT_DELETION_CANCELLED', metadata: { userId: user.id } })
  return previewAccountDeletion(user)
}

export interface PurgeOutcome {
  /** Stored receipt objects deleted after the rows. */
  deletedReceiptObjects: number
  /** Objects or prefixes whose deletion failed: kept in cloud_pending_object_deletions, retried by the maintenance job. */
  pendingReceiptObjects: number
}

/**
 * Deletes companies with their books (Kledg's triggers keep them otherwise)
 * and, after the commit, the stored objects of their receipt files (Kledg
 * Cloud is the processor: RGPD art. 28(3)(g), docs/cloud.md, Data, GDPR and
 * retention). The rows of the receipt files and staged receipts go with the
 * companies (ON DELETE CASCADE); the objects to delete are recorded in the
 * same transaction (recordCompanyObjects), so a failure or a crash after
 * the commit leaves them pending for the maintenance job, never a row
 * pointing to a deleted object. Bytes still stored in PostgreSQL
 * (receipt_files.content) live in the row and go with it.
 */
export async function purgeCompanies(companyIds: string[]): Promise<PurgeOutcome> {
  if (companyIds.length === 0) return { deletedReceiptObjects: 0, pendingReceiptObjects: 0 }
  const pending = await prisma.$transaction(async (tx) => {
    // The transaction-scoped bypasses Kledg provides for intended deletions
    // of closed years and companies with books (migrations 20261004090000
    // and 20261013090000).
    await tx.$queryRaw`SELECT set_config('kledg.closed_year_bypass', 'on', true), set_config('kledg.company_purge', 'on', true)`
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`
    const objects = await recordCompanyObjects(tx, companyIds)
    await tx.company.deleteMany({ where: { id: { in: companyIds } } })
    await tx.address.deleteMany({ where: { companyId: { in: companyIds } } })
    return objects
  })
  const { deleted, pending: left } = await deletePendingObjects(pending)
  return { deletedReceiptObjects: deleted, pendingReceiptObjects: left }
}

export interface DeletionOutcome {
  userId: string
  companies: string[]
}

/** Runs one due deletion. Throws (and leaves it scheduled) when something must be fixed first. */
export async function executeAccountDeletion(billingAccountId: string, options: { stripe?: () => Stripe } = {}): Promise<DeletionOutcome> {
  const account = await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { id: billingAccountId } })
  const user = await prisma.user.findUnique({ where: { id: account.ownerUserId }, select: { id: true, email: true, role: true } })
  const companies = await ownedCompanies(account.id)

  if (user) {
    const blockers = await blockersOf(user, new Set(companies.map((c) => c.id)))
    if (blockers.length > 0) throw new Error('Account deletion blocked: a company without another administrator')
  }
  if (account.stripeSubscriptionId && hasLiveSubscription(account.subscriptionStatus)) {
    // A failure stops here: the deletion runs again on the next maintenance pass.
    await (options.stripe ?? getStripe)().subscriptions.cancel(account.stripeSubscriptionId, { invoice_now: false, prorate: false })
  }

  const { deletedReceiptObjects, pendingReceiptObjects } = await purgeCompanies(companies.map((c) => c.id))
  await prisma.$transaction(async (tx) => {
    if (user) {
      // API keys reference their user without a foreign key (lib/auth.ts, afterDelete).
      await tx.apikey.deleteMany({ where: { referenceId: user.id } })
      await tx.user.delete({ where: { id: user.id } })
    }
    await tx.cloudTermsAcceptance.deleteMany({ where: { userId: account.ownerUserId } })
    await tx.cloudBillingAccount.delete({ where: { id: account.id } })
  })

  await writeAuditLog('warn', 'Account deleted', {
    action: 'CLOUD_ACCOUNT_DELETED',
    // Receipt objects deleted from the object storage, and those left pending for the maintenance job (purgeCompanies).
    metadata: { userId: account.ownerUserId, reason: account.deletionReason, companies: companies.map((c) => c.id), deletedReceiptObjects, pendingReceiptObjects },
  })
  if (user) {
    await sendEmail(accountDeletedEmail(user.email, LEGAL_URLS.privacy)).catch((error: unknown) => logger.error('Account deletion email failed', { error }))
  }
  return { userId: account.ownerUserId, companies: companies.map((c) => c.id) }
}

/** Due deletions, a few per run (the maintenance job runs daily). */
export async function executeDueDeletions(now: Date = new Date(), stripe?: () => Stripe): Promise<{ done: number; failed: number }> {
  const due = await prisma.cloudBillingAccount.findMany({
    where: { deletionScheduledFor: { lte: now } },
    select: { id: true },
    orderBy: { deletionScheduledFor: 'asc' },
    take: 20,
  })
  let done = 0
  let failed = 0
  for (const { id } of due) {
    try {
      await executeAccountDeletion(id, { stripe })
      done += 1
    } catch (error) {
      failed += 1
      logger.error('Scheduled account deletion failed, retried on the next run', { error, billingAccountId: id })
    }
  }
  return { done, failed }
}

/**
 * What the billing state allows, plugged into Kledg through the instance
 * policy (lib/instance/policy.ts, which loads this module lazily: it reads
 * the database). Only used with KLEDG_CLOUD_MODE=true.
 *
 * - Creating a company: needs a subscription in trial, active, or in its
 *   grace period after a failed payment, and room in the plan (Essentiel 1,
 *   Holding 5; Cabinet has no hard limit, companies beyond 25 are billed).
 *   A refusal says why in French and links to the plans.
 * - Writing to a company: refused once the owning account is read-only
 *   (CGV: 14 days after a failed payment, contract ended, deletion
 *   requested), and for the companies beyond the limit of the plan: the
 *   account's oldest companies (archived ones excepted) stay writable up to
 *   the limit, the others are read-only. The limit is checked again on
 *   every write because the plan can shrink after the creations (a switch
 *   to Essentiel in the Customer Portal, a new subscription after a Cabinet
 *   trial) and two creations at once both pass the creation check
 *   (KLEDG-CLOUD-001, KLEDG-CLOUD-002). Reads, reports, the FEC and the
 *   full export are GET requests and stay open.
 * - Instance administrators (the operator) are never restricted, and the
 *   companies they create belong to no account.
 */

import type { ActionRefusal, InstanceActor } from '@/lib/instance/types'
import { logger } from '@/lib/logger'
import { CLOUD_PATHS, UPGRADE_LINK } from './config'
import { prisma } from '@/lib/prisma'
import { withSystemContext } from '@/lib/rls/context'
import { companyLimitMessage, companyOverLimitMessage, companyReadOnlyMessage, readOnlyMessage, START_TRIAL_MESSAGE } from './messages'
import {
  accessOf,
  billingAccountOfCompany,
  countedCompanies,
  findBillingAccount,
  ownedCompanyIds,
  recordCompanyOwnership,
  virtualBillingAccount,
} from './billing/billing-account.service'
import { syncCabinetExtraCompanies } from './billing/cabinet-extra.service'

export async function cloudCompanyCreationRefusal(actor: InstanceActor, now: Date = new Date()): Promise<ActionRefusal | null> {
  if (actor.role === 'admin') return null
  const account = (await findBillingAccount(actor.id)) ?? virtualBillingAccount(actor.id, now)
  const access = accessOf(account, now)
  if (access.phase === 'none') return { message: START_TRIAL_MESSAGE, link: { label: 'Choisir une offre', href: CLOUD_PATHS.billing } }
  if (!access.writable) return { message: readOnlyMessage(access), link: UPGRADE_LINK }
  if (access.companyLimit !== null) {
    const count = await countedCompanies(account.id)
    if (count >= access.companyLimit) return { message: companyLimitMessage(access, count), link: UPGRADE_LINK }
  }
  return null
}

export async function cloudAfterCompanyCreated(companyId: string, actor: InstanceActor): Promise<void> {
  if (actor.role === 'admin') return
  const account = await recordCompanyOwnership(companyId, actor.id)
  if (account.planId === 'cabinet') {
    // Billed beyond 25 companies; a Stripe failure is caught up by the daily maintenance.
    await syncCabinetExtraCompanies(account).catch((error: unknown) =>
      logger.error('Cabinet extra companies sync failed after a creation', { error, billingAccountId: account.id }),
    )
  }
}

/**
 * The account's companies that count against its plan (owned, existing, not
 * archived), oldest first. Read in a system context: a member invited into
 * one of the companies does not reach the owner's other companies, and the
 * rank must be the same for every member. Only ids leave this function.
 */
async function countedCompanyIdsInOrder(billingAccountId: string): Promise<string[]> {
  return withSystemContext('instance-extension', async () => {
    const owned = await prisma.cloudCompanyOwnership.findMany({
      where: { billingAccountId },
      orderBy: [{ createdAt: 'asc' }, { companyId: 'asc' }],
      select: { companyId: true },
    })
    const ids = owned.map((row) => row.companyId)
    if (ids.length === 0) return []
    const counted = new Set(
      (await prisma.company.findMany({ where: { id: { in: ids }, archivedAt: null }, select: { id: true } })).map((company) => company.id),
    )
    return ids.filter((id) => counted.has(id))
  })
}

export async function cloudCompanyWriteRefusal(companyId: string, now: Date = new Date()): Promise<ActionRefusal | null> {
  const account = await billingAccountOfCompany(companyId)
  if (!account) return null
  const access = accessOf(account, now)
  if (!access.writable) return { message: companyReadOnlyMessage(access), link: UPGRADE_LINK }
  if (access.companyLimit !== null) {
    const rank = (await countedCompanyIdsInOrder(account.id)).indexOf(companyId)
    if (rank >= access.companyLimit) return { message: companyOverLimitMessage(access), link: UPGRADE_LINK }
  }
  return null
}

/**
 * The companies whose SIREN and establishment SIRETs a company must not
 * repeat (companyIdentifierScope of the instance policy, KLEDG-R3-CLOUD-01):
 * those of the billing account owning `companyId`, or of the account of
 * `actor` for a creation. The operator's companies (no ownership row) form
 * their own scope. A customer can then neither take the SIREN of a business
 * that is not a customer yet, nor learn which businesses are.
 *
 * Read in a system context: a member of one company of an account does not
 * reach its other companies, and the scope must be the same for every
 * member. Only ids leave this function, and they only feed the boolean of
 * kledg_company_identifier_taken.
 */
export async function cloudCompanyIdentifierScope(
  companyId: string | null,
  actor: Pick<InstanceActor, 'id' | 'role'> | null,
): Promise<string[]> {
  return withSystemContext('instance-extension', async () => {
    let billingAccountId: string | null = null
    if (companyId) {
      const ownership = await prisma.cloudCompanyOwnership.findUnique({ where: { companyId }, select: { billingAccountId: true } })
      billingAccountId = ownership?.billingAccountId ?? null
    } else if (actor && actor.role !== 'admin') {
      // A customer without an account owns nothing yet (and may not create a company anyway).
      const account = await prisma.cloudBillingAccount.findUnique({ where: { ownerUserId: actor.id }, select: { id: true } })
      if (!account) return []
      billingAccountId = account.id
    }
    if (billingAccountId) return ownedCompanyIds(billingAccountId)
    const operatorCompanies = await prisma.$queryRaw<{ id: string }[]>`
      SELECT c."id" FROM "companies" c
      WHERE NOT EXISTS (SELECT 1 FROM "cloud_company_ownerships" o WHERE o."companyId" = c."id")`
    return operatorCompanies.map((row) => row.id)
  })
}

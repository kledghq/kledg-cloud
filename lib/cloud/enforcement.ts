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
 *   requested). Reads, reports, the FEC and the full export are GET
 *   requests and stay open.
 * - Instance administrators (the operator) are never restricted, and the
 *   companies they create belong to no account.
 */

import type { ActionRefusal, InstanceActor } from '@/lib/instance/types'
import { logger } from '@/lib/logger'
import { CLOUD_PATHS, UPGRADE_LINK } from './config'
import { companyLimitMessage, companyReadOnlyMessage, readOnlyMessage, START_TRIAL_MESSAGE } from './messages'
import {
  accessOf,
  billingAccountOfCompany,
  countedCompanies,
  findBillingAccount,
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

export async function cloudCompanyWriteRefusal(companyId: string, now: Date = new Date()): Promise<ActionRefusal | null> {
  const account = await billingAccountOfCompany(companyId)
  if (!account) return null
  const access = accessOf(account, now)
  return access.writable ? null : { message: companyReadOnlyMessage(access), link: UPGRADE_LINK }
}

/**
 * What the billing state allows, plugged into Kledg through the instance
 * policy (lib/instance/policy.ts, which loads this module lazily: it reads
 * the database). Only used with KLEDG_CLOUD_MODE=true.
 *
 * - Creating a company: refused when the account is read-only, or when it
 *   already owns as many companies as its plan (or the trial) allows. The
 *   refusal names the limit and links to the plans.
 * - Writing to a company: refused once the owning account is read-only.
 *   Reads, reports, the FEC and the full export are GET requests and stay
 *   open (Code de commerce art. L123-22, RGPD art. 20).
 * - Instance administrators (the operator) are never restricted, and the
 *   companies they create belong to no account.
 */

import type { ActionRefusal, InstanceActor } from '@/lib/instance/types'
import { UPGRADE_LINK } from './config'
import { companyLimitMessage, companyReadOnlyMessage, readOnlyMessage } from './messages'
import {
  accessOf,
  billingAccountOfCompany,
  countedCompanies,
  findBillingAccount,
  recordCompanyOwnership,
  virtualBillingAccount,
} from './billing/billing-account.service'

export async function cloudCompanyCreationRefusal(actor: InstanceActor, now: Date = new Date()): Promise<ActionRefusal | null> {
  if (actor.role === 'admin') return null
  // A user without an account yet (an invited member) would start a trial now.
  const account = (await findBillingAccount(actor.id)) ?? virtualBillingAccount(actor.id, now)
  const access = accessOf(account, now)
  if (!access.writable) return { message: readOnlyMessage(access), link: UPGRADE_LINK }
  if (access.companyLimit !== null) {
    const count = await countedCompanies(account.id)
    if (count >= access.companyLimit) return { message: companyLimitMessage(access, count), link: UPGRADE_LINK }
  }
  return null
}

export async function cloudAfterCompanyCreated(companyId: string, actor: InstanceActor, now: Date = new Date()): Promise<void> {
  if (actor.role === 'admin') return
  await recordCompanyOwnership(companyId, actor.id, now)
}

export async function cloudCompanyWriteRefusal(companyId: string, now: Date = new Date()): Promise<ActionRefusal | null> {
  const account = await billingAccountOfCompany(companyId)
  if (!account) return null
  const access = accessOf(account, now)
  return access.writable ? null : { message: companyReadOnlyMessage(access), link: UPGRADE_LINK }
}

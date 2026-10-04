/**
 * Daily maintenance of Kledg Cloud (GET /api/cron/cloud-maintenance, Vercel
 * Cron with the CRON_SECRET bearer token). It keeps the promises of the CGV
 * that need a clock:
 * - annual renewal reminder, by email, at least a month before the date
 *   (art. 12);
 * - end of contract: an email with the end date of the 30 day read-only
 *   retrieval period and of the deletion, and the deletion scheduled for
 *   that date (art. 14);
 * - account deletions whose date has come (art. 14 and 15);
 * and keeps the books straight:
 * - the billed quantity of extra companies of Cabinet subscriptions;
 * - accounts whose address was never confirmed, deleted after a few days
 *   (they hold nothing, and keeping them would let anyone squat an address);
 * - Stripe event ids older than 90 days.
 *
 * Billing states need no job: they follow from the stored dates
 * (lib/cloud/billing/state.ts). Every step is idempotent: a run that fails
 * halfway is completed by the next one.
 */

import { timingSafeEqual } from 'node:crypto'
import type Stripe from 'stripe'
import { prisma } from '@/lib/prisma'
import { withSystemContext } from '@/lib/rls/context'
import { UnauthorizedError } from '@/lib/accounting/errors'
import { getAppUrl } from '@/lib/config'
import { sendEmail } from '@/lib/email'
import { logger } from '@/lib/logger'
import { CLOUD_PATHS, cloudSettings } from './config'
import { addDays } from './billing/state'
import { PLANS, isPlanId } from './billing/plans'
import { purgeProcessedStripeEvents } from './billing/stripe-webhook.service'
import { syncAllCabinetExtraCompanies } from './billing/cabinet-extra.service'
import { executeDueDeletions } from './account/account-deletion.service'
import { contractEndedEmail, renewalReminderEmail } from './email-templates'

/** Whether the request carries the CRON_SECRET bearer token (constant-time comparison). */
export function assertCronRequest(request: Request): void {
  const secret = process.env.CRON_SECRET
  const expected = Buffer.from(`Bearer ${secret ?? ''}`)
  const received = Buffer.from(request.headers.get('authorization') ?? '')
  if (!secret || received.length !== expected.length || !timingSafeEqual(received, expected)) throw new UnauthorizedError('Non authentifié')
}

/** Email addresses of account owners, by user id. */
async function ownerEmails(userIds: string[]): Promise<Map<string, string>> {
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
  return new Map(users.map((u) => [u.id, u.email]))
}

/** CGV art. 12: annual subscriptions renewing within the notice period get their reminder, once per period. */
export async function sendRenewalReminders(now: Date = new Date()): Promise<number> {
  const due = await prisma.cloudBillingAccount.findMany({
    where: {
      subscriptionStatus: 'active',
      billingInterval: 'year',
      cancelAtPeriodEnd: false,
      currentPeriodEnd: { gt: now, lte: addDays(now, cloudSettings().renewalNoticeDays) },
    },
    take: 500,
  })
  const pending = due.filter((a) => a.currentPeriodEnd && a.renewalReminderFor?.getTime() !== a.currentPeriodEnd.getTime())
  const emails = await ownerEmails(pending.map((a) => a.ownerUserId))
  let sent = 0
  for (const account of pending) {
    const email = emails.get(account.ownerUserId)
    if (!email || !account.currentPeriodEnd) continue
    try {
      const planName = isPlanId(account.planId) ? PLANS[account.planId].name : 'Kledg Cloud'
      await sendEmail(renewalReminderEmail(email, account.currentPeriodEnd, planName, `${getAppUrl()}${CLOUD_PATHS.billing}`))
      await prisma.cloudBillingAccount.update({ where: { id: account.id }, data: { renewalReminderFor: account.currentPeriodEnd } })
      sent += 1
    } catch (error) {
      logger.error('Renewal reminder failed, retried on the next run', { error, billingAccountId: account.id })
    }
  }
  return sent
}

/**
 * CGV art. 14: a contract that ended (trial without a card, cancellation,
 * unpaid) gets its notice with the end of the retrieval period, and its
 * deletion is scheduled for that date.
 */
export async function noticeEndedContracts(now: Date = new Date()): Promise<number> {
  const ended = await prisma.cloudBillingAccount.findMany({
    where: { subscriptionStatus: { in: ['canceled', 'incomplete_expired'] }, deletionScheduledFor: null },
    take: 500,
  })
  const emails = await ownerEmails(ended.map((a) => a.ownerUserId))
  const { retrievalDays } = cloudSettings()
  let noticed = 0
  for (const account of ended) {
    const endedAt = account.subscriptionEndedAt ?? account.currentPeriodEnd ?? now
    // 30 days after the end; a notice that goes out late still leaves a week to export.
    const due = addDays(endedAt, retrievalDays)
    const retrievalEnds = due > addDays(now, 7) ? due : addDays(now, 7)
    try {
      const email = emails.get(account.ownerUserId)
      if (email && account.contractEndNoticeFor?.getTime() !== endedAt.getTime()) {
        await sendEmail(contractEndedEmail(email, endedAt, retrievalEnds, `${getAppUrl()}${CLOUD_PATHS.data}`))
      }
      await prisma.cloudBillingAccount.update({
        where: { id: account.id },
        data: { contractEndNoticeFor: endedAt, deletionScheduledFor: retrievalEnds, deletionReason: 'contract_ended' },
      })
      noticed += 1
    } catch (error) {
      logger.error('End of contract notice failed, retried on the next run', { error, billingAccountId: account.id })
    }
  }
  return noticed
}

/** Unconfirmed accounts older than the limit, which own and belong to nothing. */
export async function purgeUnverifiedAccounts(now: Date = new Date()): Promise<number> {
  const before = addDays(now, -cloudSettings().unverifiedAccountDays)
  const stale = await prisma.user.findMany({
    where: { emailVerified: false, role: { not: 'admin' }, createdAt: { lt: before }, members: { none: {} } },
    select: { id: true },
    take: 200,
  })
  const owners = new Set(
    (
      await prisma.cloudBillingAccount.findMany({
        where: { ownerUserId: { in: stale.map((u) => u.id) }, OR: [{ companies: { some: {} } }, { stripeCustomerId: { not: null } }] },
        select: { ownerUserId: true },
      })
    ).map((row) => row.ownerUserId),
  )
  const ids = stale.map((u) => u.id).filter((id) => !owners.has(id))
  if (ids.length === 0) return 0
  await prisma.$transaction([
    prisma.apikey.deleteMany({ where: { referenceId: { in: ids } } }),
    prisma.cloudTermsAcceptance.deleteMany({ where: { userId: { in: ids } } }),
    prisma.cloudBillingAccount.deleteMany({ where: { ownerUserId: { in: ids } } }),
    prisma.user.deleteMany({ where: { id: { in: ids } } }),
  ])
  return ids.length
}

export interface MaintenanceReport {
  renewalReminders: number
  endedContracts: number
  deletions: { done: number; failed: number }
  cabinetExtraUpdated: number
  unverifiedPurged: number
  stripeEventsPurged: number
}

export async function runCloudMaintenance(now: Date = new Date(), stripe?: () => Stripe): Promise<MaintenanceReport> {
  // A server job without a user, after the CRON_SECRET check: it walks every billing account (docs/rls.md).
  return withSystemContext('instance-extension', () => runMaintenanceSteps(now, stripe))
}

async function runMaintenanceSteps(now: Date, stripe?: () => Stripe): Promise<MaintenanceReport> {
  const report: MaintenanceReport = {
    renewalReminders: await sendRenewalReminders(now),
    endedContracts: await noticeEndedContracts(now),
    deletions: await executeDueDeletions(now, stripe),
    cabinetExtraUpdated: await syncAllCabinetExtraCompanies(stripe),
    unverifiedPurged: await purgeUnverifiedAccounts(now),
    stripeEventsPurged: await purgeProcessedStripeEvents(now),
  }
  logger.info('Kledg Cloud maintenance', report)
  return report
}

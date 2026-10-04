/**
 * Operator console of Kledg Cloud (instance administrators only, adminRoute
 * and the /settings/console page): the billing accounts with their owner,
 * plan, state, trial end and number of companies, read-only; and one
 * action, extending a trial (on the Stripe subscription, which stays the
 * truth; the webhook confirms it). Every extension is written to the audit
 * log.
 */

import type Stripe from 'stripe'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ConflictError, NotFoundError } from '@/lib/accounting/errors'
import { enforceRateLimit } from '@/lib/rate-limit'
import { writeAuditLog } from '@/lib/audit'
import type { CurrentUser } from '@/lib/session'
import { accessOf } from '../billing/billing-account.service'
import { addDays, type BillingPhase } from '../billing/state'
import { getStripe } from '../billing/stripe'

export interface OperatorAccount {
  id: string
  ownerEmail: string | null
  planId: string | null
  billingInterval: string | null
  phase: BillingPhase
  subscriptionStatus: string | null
  trialEnd: string | null
  companies: number
  extraCompanies: number
  dedicatedDatabase: boolean
  deletionScheduledFor: string | null
  createdAt: string
}

export const OperatorListQuery = z.object({
  search: z.string().trim().max(200).optional(),
  cursor: z.string().max(100).optional(),
})

const PAGE = 50

/** A page of billing accounts, newest first; `search` filters on the owner's address. */
export async function listOperatorAccounts(query: z.infer<typeof OperatorListQuery>, now: Date = new Date()): Promise<{ accounts: OperatorAccount[]; nextCursor: string | null }> {
  const owners = query.search
    ? (await prisma.user.findMany({ where: { email: { contains: query.search, mode: 'insensitive' } }, select: { id: true }, take: 200 })).map((u) => u.id)
    : null
  const rows = await prisma.cloudBillingAccount.findMany({
    where: owners ? { ownerUserId: { in: owners } } : {},
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: PAGE + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: { _count: { select: { companies: true } } },
  })
  const page = rows.slice(0, PAGE)
  const emails = new Map(
    (await prisma.user.findMany({ where: { id: { in: page.map((r) => r.ownerUserId) } }, select: { id: true, email: true } })).map((u) => [u.id, u.email]),
  )
  return {
    accounts: page.map((row) => ({
      id: row.id,
      ownerEmail: emails.get(row.ownerUserId) ?? null,
      planId: row.planId,
      billingInterval: row.billingInterval,
      phase: accessOf(row, now).phase,
      subscriptionStatus: row.subscriptionStatus,
      trialEnd: row.trialEnd?.toISOString() ?? null,
      companies: row._count.companies,
      extraCompanies: row.extraCompanies,
      dedicatedDatabase: row.dedicatedDatabase,
      deletionScheduledFor: row.deletionScheduledFor?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: rows.length > PAGE ? page[page.length - 1].id : null,
  }
}

export const ExtendTrialSchema = z.object({
  days: z.coerce.number({ error: 'Nombre de jours invalide.' }).int().min(1, 'Au moins 1 jour.').max(60, 'Au plus 60 jours.'),
})

/** Extends the trial of a trialing subscription by `days` from its current end. */
export async function extendTrial(
  admin: CurrentUser,
  billingAccountId: string,
  input: z.infer<typeof ExtendTrialSchema>,
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<{ trialEnd: string }> {
  await enforceRateLimit('cloud-operator', admin.id)
  const account = await prisma.cloudBillingAccount.findUnique({ where: { id: billingAccountId } })
  if (!account) throw new NotFoundError('Compte introuvable')
  if (account.subscriptionStatus !== 'trialing' || !account.stripeSubscriptionId) {
    throw new ConflictError("Ce compte n'est pas en période d'essai : seul un essai en cours peut être prolongé.")
  }
  const now = options.now ?? new Date()
  const from = account.trialEnd && account.trialEnd > now ? account.trialEnd : now
  const trialEnd = addDays(from, input.days)
  await (options.stripe ?? getStripe()).subscriptions.update(account.stripeSubscriptionId, {
    trial_end: Math.floor(trialEnd.getTime() / 1000),
    proration_behavior: 'none',
  })
  await prisma.cloudBillingAccount.update({ where: { id: account.id }, data: { trialEnd } })
  await writeAuditLog('info', 'Trial extended', {
    action: 'CLOUD_TRIAL_EXTENDED',
    metadata: { adminId: admin.id, billingAccountId: account.id, days: input.days, trialEnd: trialEnd.toISOString() },
  })
  return { trialEnd: trialEnd.toISOString() }
}

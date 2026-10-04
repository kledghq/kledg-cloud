/**
 * Billing accounts of Kledg Cloud: the paying entity is the user who owns
 * companies. The row is created when the user first goes to Checkout (or
 * owns a company); its subscription, trial included, is Stripe's, mirrored
 * by the webhook. Members of someone else's companies never pay and never
 * count.
 *
 * Companies count against the plan when their ownership row points to the
 * account and they are not archived. Companies created by the operator have
 * no ownership row: they are neither billed nor restricted.
 */

import type { CloudBillingAccount, Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { cloudSettings } from '../config'
import { billingAccess, type BillingAccess } from './state'

type Db = Prisma.TransactionClient | typeof prisma

/** The access of `account` now (or at `now`), with the configured durations. */
export function accessOf(account: CloudBillingAccount, now: Date = new Date()): BillingAccess {
  return billingAccess(account, now, cloudSettings())
}

export async function findBillingAccount(userId: string, db: Db = prisma): Promise<CloudBillingAccount | null> {
  return db.cloudBillingAccount.findUnique({ where: { ownerUserId: userId } })
}

/** The account of `userId`, created when missing (idempotent, safe under concurrency). */
export async function ensureBillingAccount(userId: string, db: Db = prisma): Promise<CloudBillingAccount> {
  return db.cloudBillingAccount.upsert({ where: { ownerUserId: userId }, create: { ownerUserId: userId }, update: {} })
}

/** What an account is for a user without one: no subscription yet. Lets pages and checks answer without writing a row. */
export function virtualBillingAccount(userId: string, now: Date = new Date()): CloudBillingAccount {
  return {
    id: '',
    ownerUserId: userId,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    subscriptionStatus: null,
    planId: null,
    priceId: null,
    billingInterval: null,
    trialEnd: null,
    trialUsed: false,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    subscriptionEndedAt: null,
    paymentFailedAt: null,
    extraCompanies: 0,
    dedicatedDatabase: false,
    discountSummary: null,
    discountEnd: null,
    stripeSyncedAt: null,
    renewalReminderFor: null,
    contractEndNoticeFor: null,
    deletionRequestedAt: null,
    deletionScheduledFor: null,
    deletionReason: null,
    createdAt: now,
    updatedAt: now,
  }
}

/** Ids of the companies the account owns (archived ones included). */
export async function ownedCompanyIds(billingAccountId: string, db: Db = prisma): Promise<string[]> {
  if (!billingAccountId) return []
  const rows = await db.cloudCompanyOwnership.findMany({ where: { billingAccountId }, select: { companyId: true } })
  return rows.map((row) => row.companyId)
}

/** Companies counted against the plan: owned, existing and not archived. */
export async function countedCompanies(billingAccountId: string, db: Db = prisma): Promise<number> {
  const ids = await ownedCompanyIds(billingAccountId, db)
  if (ids.length === 0) return 0
  return db.company.count({ where: { id: { in: ids }, archivedAt: null } })
}

/**
 * Records that `userId`'s account owns the new company (afterCompanyCreated
 * hook). Serialized per account so two creations at once are both counted.
 */
export async function recordCompanyOwnership(companyId: string, userId: string): Promise<CloudBillingAccount> {
  return prisma.$transaction(async (tx) => {
    const account = await ensureBillingAccount(userId, tx)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`kledg-cloud:billing:${account.id}`}))`
    await tx.cloudCompanyOwnership.upsert({ where: { companyId }, create: { companyId, billingAccountId: account.id }, update: {} })
    return account
  })
}

/** Whether `userId` is a member of any company (their own or someone else's). */
export async function belongsToAnyCompany(userId: string): Promise<boolean> {
  return (await prisma.member.count({ where: { userId } })) > 0
}

/** The billing account owning `companyId`, or null for a company nobody owns (created by the operator). */
export async function billingAccountOfCompany(companyId: string): Promise<CloudBillingAccount | null> {
  const ownership = await prisma.cloudCompanyOwnership.findUnique({ where: { companyId }, select: { billingAccount: true } })
  return ownership?.billingAccount ?? null
}

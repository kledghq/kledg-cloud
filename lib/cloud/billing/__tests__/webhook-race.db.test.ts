/**
 * Stripe webhook, concurrent events about one subscription (pentest round 3,
 * KLEDG-R3-CLOUD-02), against PostgreSQL with Stripe's HTTP answers held:
 * two different events delivered at the same time are applied one after the
 * other per billing account, each reading Stripe under the account's lock,
 * so the stored state is always the latest Stripe answered. A cancelled
 * trial ends up cancelled (read-only, retrieval period) whatever the order
 * the deliveries complete in.
 *
 * Skipped when the test database server is unreachable.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'

await vi.hoisted(async () => {
  const { useTestDatabase } = await import('@/lib/__tests__/helpers/test-db')
  useTestDatabase('cloud_webhook_race')
  process.env.KLEDG_CLOUD_MODE = 'true'
})

import { prepareTestDatabase, testDatabaseAvailable } from '@/lib/__tests__/helpers/test-db'
import { stripeEvent, subscriptionObject } from '../../__tests__/helpers/stripe-fixtures'
import { createStripe } from '@/lib/cloud/billing/stripe'

const available = await testDatabaseAvailable()

const respond = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_Test' } })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!available)('Stripe webhook, concurrent events (KLEDG-R3-CLOUD-02)', () => {
  let prisma: typeof import('@/lib/prisma').prisma

  beforeAll(async () => {
    await prepareTestDatabase('cloud_webhook_race')
    ;({ prisma } = await import('@/lib/prisma'))
  }, 120_000)

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  it('never lets an older snapshot overwrite a newer one: a cancelled trial ends up cancelled', async () => {
    const { applyStripeEvent } = await import('@/lib/cloud/billing/stripe-webhook.service')
    const { withSystemContext } = await import('@/lib/rls/context')
    const { accessOf } = await import('@/lib/cloud/billing/billing-account.service')
    const now = new Date()
    const trial = { start: new Date(now.getTime() - 5 * 86_400_000), end: new Date(now.getTime() + 25 * 86_400_000) }
    await prisma.cloudBillingAccount.create({
      data: { id: 'ba-race', ownerUserId: 'u-race', stripeCustomerId: 'cus_TestRace00001', stripeSubscriptionId: 'sub_TestRace00001', subscriptionStatus: 'trialing', planId: 'holding', trialUsed: true },
    })

    const trialing = subscriptionObject({ id: 'sub_TestRace00001', customer: 'cus_TestRace00001', status: 'trialing', trial })
    const canceled = subscriptionObject({ id: 'sub_TestRace00001', customer: 'cus_TestRace00001', status: 'canceled', trial, endedAt: now })

    // Stripe answers the first read (taken before the cancellation) slowly, any later read at once.
    let release!: () => void
    const firstReadHeld = new Promise<void>((resolve) => (release = resolve))
    let reads = 0
    const fetchFn = (async () => {
      reads += 1
      if (reads === 1) {
        const body = trialing
        await firstReadHeld
        return respond(body)
      }
      return respond(canceled)
    }) as typeof fetch
    const stripe = createStripe(['sk', 'test', 'kledgcloud'.repeat(3)].join('_'), fetchFn)

    const updated = stripeEvent('customer.subscription.updated', trialing, now, 'evt_TestRaceUpdated') as unknown as Stripe.Event
    const deleted = stripeEvent('customer.subscription.deleted', canceled, now, 'evt_TestRaceDeleted') as unknown as Stripe.Event

    const first = withSystemContext('instance-extension', () => applyStripeEvent(updated, stripe))
    while (reads < 1) await sleep(5)
    const second = withSystemContext('instance-extension', () => applyStripeEvent(deleted, stripe))
    // The second delivery waits for the account's lock: it has not read Stripe yet.
    await sleep(300)
    expect(reads).toBe(1)

    release()
    expect(await first).toEqual({ status: 'applied', billingAccountId: 'ba-race' })
    expect(await second).toEqual({ status: 'applied', billingAccountId: 'ba-race' })
    expect(reads).toBe(2)

    const account = await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { id: 'ba-race' } })
    expect(account.subscriptionStatus).toBe('canceled')
    expect(accessOf(account, now).writable).toBe(false)
    expect(account.stripeSyncedAt).not.toBeNull()
  })

  it('[KLEDG-CLOUD-005] the daily reconciliation reads again the accounts whose trial ended without a webhook', async () => {
    const { resyncStaleBillingAccounts } = await import('@/lib/cloud/billing/stripe-webhook.service')
    const { withSystemContext } = await import('@/lib/rls/context')
    const now = new Date()
    const trial = { start: new Date(now.getTime() - 33 * 86_400_000), end: new Date(now.getTime() - 3 * 86_400_000) }
    await prisma.cloudBillingAccount.create({
      data: {
        id: 'ba-missed',
        ownerUserId: 'u-missed',
        stripeCustomerId: 'cus_TestMissed0001',
        stripeSubscriptionId: 'sub_TestMissed0001',
        subscriptionStatus: 'trialing',
        planId: 'holding',
        trialEnd: trial.end,
        trialUsed: true,
      },
    })
    // A running trial is not read again.
    await prisma.cloudBillingAccount.create({
      data: { id: 'ba-running', ownerUserId: 'u-running', stripeSubscriptionId: 'sub_TestRunning001', subscriptionStatus: 'trialing', trialEnd: new Date(now.getTime() + 86_400_000) },
    })
    const paths: string[] = []
    const fetchFn = (async (input: string | URL | Request) => {
      paths.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname)
      return respond(subscriptionObject({ id: 'sub_TestMissed0001', customer: 'cus_TestMissed0001', status: 'canceled', trial, endedAt: trial.end }))
    }) as typeof fetch
    const stripe = createStripe(['sk', 'test', 'kledgcloud'.repeat(3)].join('_'), fetchFn)

    expect(await withSystemContext('instance-extension', () => resyncStaleBillingAccounts(() => stripe, now))).toBe(1)
    expect(paths).toEqual(['/v1/subscriptions/sub_TestMissed0001'])
    const account = await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { id: 'ba-missed' } })
    expect(account.subscriptionStatus).toBe('canceled')
    expect((await prisma.cloudBillingAccount.findUniqueOrThrow({ where: { id: 'ba-running' } })).subscriptionStatus).toBe('trialing')
  })
})

/**
 * Cabinet plan: 25 companies included, each company beyond billed through
 * a quantity line on the subscription (product kledg_plan
 * cabinet_extra_company). The quantity follows the companies the account
 * owns (archived ones excepted): set after each company creation and
 * checked again by the daily maintenance, with Stripe prorations.
 *
 * An existing extra line keeps its price (prices are locked for early
 * adopters); a new line takes the current price of its lookup key.
 */

import type Stripe from 'stripe'
import type { CloudBillingAccount } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { logger } from '@/lib/logger'
import { countedCompanies } from './billing-account.service'
import { extraCompaniesFor, isPlanId, type BillingInterval } from './plans'
import { hasLiveSubscription } from './state'
import { priceOf } from './stripe-prices'
import { getStripe } from './stripe'

const kindOf = (item: Stripe.SubscriptionItem) => {
  const product = item.price.product
  return typeof product === 'object' && product && !('deleted' in product && product.deleted) ? (product as Stripe.Product).metadata?.kledg_plan : undefined
}

/** Sets the extra company quantity of a Cabinet subscription; answers the billed quantity. */
export async function syncCabinetExtraCompanies(account: CloudBillingAccount, stripe: Stripe = getStripe()): Promise<number> {
  if (account.planId !== 'cabinet' || !account.stripeSubscriptionId || !hasLiveSubscription(account.subscriptionStatus)) return account.extraCompanies
  const plan = isPlanId(account.planId) ? account.planId : null
  const wanted = extraCompaniesFor(plan, await countedCompanies(account.id))
  if (wanted === account.extraCompanies) return wanted

  const subscription = await stripe.subscriptions.retrieve(account.stripeSubscriptionId, { expand: ['items.data.price.product'] })
  const line = subscription.items.data.find((item) => kindOf(item) === 'cabinet_extra_company')
  if (line && wanted === 0) {
    await stripe.subscriptionItems.del(line.id, { proration_behavior: 'create_prorations' })
  } else if (line) {
    await stripe.subscriptionItems.update(line.id, { quantity: wanted, proration_behavior: 'create_prorations' })
  } else if (wanted > 0) {
    const interval = (account.billingInterval === 'year' ? 'year' : 'month') as BillingInterval
    const price = await priceOf(stripe, 'cabinet_extra_company', interval)
    if (!price) {
      logger.error('No Stripe price for the Cabinet extra companies', { interval })
      return account.extraCompanies
    }
    await stripe.subscriptionItems.create({ subscription: subscription.id, price: price.id, quantity: wanted, proration_behavior: 'create_prorations' })
  }
  await prisma.cloudBillingAccount.update({ where: { id: account.id }, data: { extraCompanies: wanted } })
  return wanted
}

/** Daily check of every live Cabinet subscription (a failure waits for the next run). */
export async function syncAllCabinetExtraCompanies(stripe?: () => Stripe): Promise<number> {
  const accounts = await prisma.cloudBillingAccount.findMany({ where: { planId: 'cabinet', stripeSubscriptionId: { not: null } }, take: 500 })
  let changed = 0
  for (const account of accounts) {
    try {
      if ((await syncCabinetExtraCompanies(account, (stripe ?? getStripe)())) !== account.extraCompanies) changed += 1
    } catch (error) {
      logger.error('Cabinet extra companies sync failed', { error, billingAccountId: account.id })
    }
  }
  return changed
}

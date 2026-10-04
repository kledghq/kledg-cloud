/**
 * Plans of Kledg Cloud. Pure (no database, no Node APIs).
 *
 * The names, limits and descriptions below are placeholders until the
 * offer is final; prices live in Stripe only. Each plan reads the Stripe
 * price ids of its billing intervals from environment variables, so no
 * price id is ever written in the code (docs/cloud.md, "Stripe"). A plan
 * whose price is not configured is not offered at checkout.
 *
 * What a plan limits is the number of companies its billing account owns:
 * the companies created by the account's owner. Members invited to a
 * company never pay and never count.
 */

export const PLAN_IDS = ['essentiel', 'holding', 'cabinet'] as const
export type PlanId = (typeof PLAN_IDS)[number]

export const BILLING_INTERVALS = ['month', 'year'] as const
export type BillingInterval = (typeof BILLING_INTERVALS)[number]

export interface Plan {
  id: PlanId
  /** Shown to customers (French). */
  name: string
  /** One sentence for the plan picker (French). */
  description: string
  /** Companies the account may own, null for no limit. */
  companyLimit: number | null
  /** Environment variables holding the Stripe price id of each interval. */
  priceEnv: Record<BillingInterval, string>
}

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  essentiel: {
    id: 'essentiel',
    name: 'Essentiel',
    description: 'Une société, toute la comptabilité.',
    companyLimit: 1,
    priceEnv: { month: 'STRIPE_PRICE_ESSENTIEL_MONTHLY', year: 'STRIPE_PRICE_ESSENTIEL_YEARLY' },
  },
  holding: {
    id: 'holding',
    name: 'Holding',
    description: "Jusqu'à cinq sociétés : une holding et ses filiales.",
    companyLimit: 5,
    priceEnv: { month: 'STRIPE_PRICE_HOLDING_MONTHLY', year: 'STRIPE_PRICE_HOLDING_YEARLY' },
  },
  cabinet: {
    id: 'cabinet',
    name: 'Cabinet',
    description: 'Pour les experts-comptables : les sociétés de vos clients.',
    companyLimit: 100,
    priceEnv: { month: 'STRIPE_PRICE_CABINET_MONTHLY', year: 'STRIPE_PRICE_CABINET_YEARLY' },
  },
}

type Env = Record<string, string | undefined>

/** A Stripe price id as Stripe issues them (price_...). Anything else in the variable is ignored. */
const PRICE_ID = /^price_[A-Za-z0-9]{8,255}$/

/** The Stripe price of `plan` for `interval`, or null when it is not configured. */
export function priceIdFor(plan: PlanId, interval: BillingInterval, env: Env = process.env): string | null {
  const value = env[PLANS[plan].priceEnv[interval]]?.trim()
  return value && PRICE_ID.test(value) ? value : null
}

/** The plan a Stripe price belongs to (any interval), or null for a price this instance does not sell. */
export function planOfPrice(priceId: string | null | undefined, env: Env = process.env): PlanId | null {
  if (!priceId) return null
  for (const plan of PLAN_IDS) {
    for (const interval of BILLING_INTERVALS) {
      if (priceIdFor(plan, interval, env) === priceId) return plan
    }
  }
  return null
}

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value)
}

/** The plans offered at checkout: those with at least one configured price, with their intervals. */
export function offeredPlans(env: Env = process.env): Array<Plan & { intervals: BillingInterval[] }> {
  return PLAN_IDS.map((id) => ({ ...PLANS[id], intervals: BILLING_INTERVALS.filter((i) => priceIdFor(id, i, env)) })).filter(
    (plan) => plan.intervals.length > 0,
  )
}

/** "1 société", "5 sociétés", "un nombre illimité de sociétés". */
export function companyLimitLabel(limit: number | null): string {
  if (limit === null) return 'un nombre illimité de sociétés'
  return limit === 1 ? '1 société' : `${limit} sociétés`
}

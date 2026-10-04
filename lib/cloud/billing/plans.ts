/**
 * Plans of Kledg Cloud. Pure (no database, no Node APIs).
 *
 * Prices live in Stripe only: each price carries a lookup key, resolved at
 * run time (stripe-prices.ts), and each product a `kledg_plan` metadata
 * that names what it is. No price id is ever written in the code or the
 * environment, so the operator can create a new price and move the lookup
 * key to it without a deployment. Existing subscriptions keep the price
 * they were sold at (early adopters keep it for life): nothing here ever
 * migrates them.
 *
 * What a plan limits is the number of companies its billing account owns
 * (the companies created by the account's owner). Members invited to a
 * company never pay and never count. Cabinet includes 25 companies; each
 * company beyond is billed through a quantity line on the subscription.
 */

export const PLAN_IDS = ['essentiel', 'holding', 'cabinet'] as const
export type PlanId = (typeof PLAN_IDS)[number]

export const BILLING_INTERVALS = ['month', 'year'] as const
export type BillingInterval = (typeof BILLING_INTERVALS)[number]

/** Values of the `kledg_plan` metadata of the Stripe products. */
export const PRODUCT_KINDS = ['essentiel', 'holding', 'cabinet', 'cabinet_extra_company', 'dedicated_database'] as const
export type ProductKind = (typeof PRODUCT_KINDS)[number]

export interface Plan {
  id: PlanId
  /** Shown to customers (French). */
  name: string
  /** One sentence for the plan picker (French). */
  description: string
  /** Companies the account may own, null for no hard limit. */
  companyLimit: number | null
  /** Companies included before extra companies are billed (Cabinet). */
  includedCompanies: number | null
}

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  essentiel: {
    id: 'essentiel',
    name: 'Essentiel',
    description: 'Une société, toute la comptabilité.',
    companyLimit: 1,
    includedCompanies: null,
  },
  holding: {
    id: 'holding',
    name: 'Holding',
    description: "Jusqu'à cinq sociétés : une holding et ses filiales.",
    companyLimit: 5,
    includedCompanies: null,
  },
  cabinet: {
    id: 'cabinet',
    name: 'Cabinet',
    description: 'Pour les experts-comptables : 25 sociétés incluses, chaque société en plus facturée à part.',
    companyLimit: null,
    includedCompanies: 25,
  },
}

/** Lookup key of the Stripe price of `kind` billed every `interval` (kledg_holding_yearly...). */
export function lookupKey(kind: ProductKind, interval: BillingInterval): string {
  return `kledg_${kind}_${interval === 'month' ? 'monthly' : 'yearly'}`
}

/** Every lookup key the service sells (10: the most Stripe resolves in one list call). */
export const ALL_LOOKUP_KEYS: readonly string[] = PRODUCT_KINDS.flatMap((kind) => BILLING_INTERVALS.map((interval) => lookupKey(kind, interval)))

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value)
}

export function isProductKind(value: unknown): value is ProductKind {
  return typeof value === 'string' && (PRODUCT_KINDS as readonly string[]).includes(value)
}

/** Billed extra companies of a Cabinet account owning `count` companies. */
export function extraCompaniesFor(plan: PlanId | null, count: number): number {
  const included = plan ? PLANS[plan].includedCompanies : null
  return included === null ? 0 : Math.max(0, count - included)
}

/** "1 société", "5 sociétés", "25 sociétés incluses". */
export function companyLimitLabel(limit: number | null, included: number | null = null): string {
  if (limit === null) return included ? `${included} sociétés incluses, puis à l'unité` : 'un nombre illimité de sociétés'
  return limit === 1 ? '1 société' : `${limit} sociétés`
}

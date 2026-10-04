/**
 * Configuration of Kledg Cloud, the hosted service (docs/cloud.md). Pure: no
 * database, no Node APIs, so the instance policy and the request proxy can
 * read it.
 *
 * Every hosted feature (public sign-up, billing, read-only mode, the
 * operator console) is on only with KLEDG_CLOUD_MODE=true. Without it this
 * repository behaves exactly like Kledg: its own test suite runs that way.
 */

type Env = Record<string, string | undefined>

/** Whether this deployment is the hosted service. */
export function isCloudMode(env: Env = process.env): boolean {
  return env.KLEDG_CLOUD_MODE === 'true'
}

function positiveInteger(value: string | undefined, fallback: number, max: number): number {
  if (!value || !/^\d+$/.test(value.trim())) return fallback
  const parsed = Number(value.trim())
  return parsed >= 1 && parsed <= max ? parsed : fallback
}

export interface CloudSettings {
  /** Free trial length, without a card (KLEDG_CLOUD_TRIAL_DAYS, default 30). */
  trialDays: number
  /**
   * Days an account keeps writing after its trial ended, a payment failed or
   * its subscription ended, before it turns read-only (KLEDG_CLOUD_GRACE_DAYS,
   * default 14).
   */
  graceDays: number
  /** Days between an account deletion request and the deletion (KLEDG_CLOUD_DELETION_DAYS, default 30). */
  deletionDays: number
  /** Companies an account may hold during its trial (KLEDG_CLOUD_TRIAL_COMPANIES, default 3). */
  trialCompanyLimit: number
  /** Days an account that never confirmed its address is kept (KLEDG_CLOUD_UNVERIFIED_DAYS, default 7). */
  unverifiedAccountDays: number
}

export function cloudSettings(env: Env = process.env): CloudSettings {
  return {
    trialDays: positiveInteger(env.KLEDG_CLOUD_TRIAL_DAYS, 30, 365),
    graceDays: positiveInteger(env.KLEDG_CLOUD_GRACE_DAYS, 14, 90),
    deletionDays: positiveInteger(env.KLEDG_CLOUD_DELETION_DAYS, 30, 365),
    trialCompanyLimit: positiveInteger(env.KLEDG_CLOUD_TRIAL_COMPANIES, 3, 1000),
    unverifiedAccountDays: positiveInteger(env.KLEDG_CLOUD_UNVERIFIED_DAYS, 7, 90),
  }
}

/** Pages of the hosted service, linked from messages and emails. */
export const CLOUD_PATHS = {
  signup: '/signup',
  signupVerified: '/signup/verified',
  billing: '/settings/billing',
  data: '/settings/data',
  console: '/settings/console',
  legal: '/legal',
} as const

/** Link of refusals that a plan lifts (company limit, read-only account). */
export const UPGRADE_LINK = { label: 'Voir les offres', href: CLOUD_PATHS.billing } as const

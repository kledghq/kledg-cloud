/**
 * Configuration of Kledg Cloud, the hosted service (docs/cloud.md). Pure: no
 * database, no Node APIs, so the instance policy and the request proxy can
 * read it.
 *
 * Every hosted feature (public sign-up, billing, read-only mode, the
 * operator console) is on only with KLEDG_CLOUD_MODE=true. Without it this
 * repository behaves exactly like Kledg: its own test suite runs that way.
 *
 * The durations default to the commitments of the published CGV
 * (version 1.0, https://www.kledg.com/fr/terms): a 30 day trial, 14 days
 * after a failed payment before read-only, 30 days of read-only retrieval
 * after the contract ends, 30 days to cancel an account deletion.
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
  /** Free trial, without a card, started at Checkout (KLEDG_CLOUD_TRIAL_DAYS, CGV: 30). */
  trialDays: number
  /** Days after a failed payment before the account turns read-only (KLEDG_CLOUD_GRACE_DAYS, CGV: 14). */
  graceDays: number
  /** Read-only retrieval period after the contract ends, before deletion (KLEDG_CLOUD_RETRIEVAL_DAYS, CGV: 30). */
  retrievalDays: number
  /** Days to cancel an account deletion request, account read-only meanwhile (KLEDG_CLOUD_DELETION_DAYS, CGV: 30). */
  deletionDays: number
  /** Days before an annual renewal when the reminder is sent (KLEDG_CLOUD_RENEWAL_NOTICE_DAYS, CGV: at least a month). */
  renewalNoticeDays: number
  /** Days an account that never confirmed its address is kept (KLEDG_CLOUD_UNVERIFIED_DAYS, default 7). */
  unverifiedAccountDays: number
}

export function cloudSettings(env: Env = process.env): CloudSettings {
  return {
    trialDays: positiveInteger(env.KLEDG_CLOUD_TRIAL_DAYS, 30, 90),
    graceDays: positiveInteger(env.KLEDG_CLOUD_GRACE_DAYS, 14, 90),
    retrievalDays: positiveInteger(env.KLEDG_CLOUD_RETRIEVAL_DAYS, 30, 90),
    deletionDays: positiveInteger(env.KLEDG_CLOUD_DELETION_DAYS, 30, 90),
    // Never below 31 days: the CGV promise "at least one month before".
    renewalNoticeDays: Math.max(31, positiveInteger(env.KLEDG_CLOUD_RENEWAL_NOTICE_DAYS, 35, 90)),
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
} as const

/** Legal documents, published on the website (French versions). */
export const LEGAL_URLS = {
  cgv: 'https://www.kledg.com/fr/terms',
  privacy: 'https://www.kledg.com/fr/privacy',
  dpa: 'https://www.kledg.com/fr/dpa',
  legalNotice: 'https://www.kledg.com/fr/legal-notice',
} as const

/** Link of refusals that a plan lifts (company limit, no subscription, read-only account). */
export const UPGRADE_LINK = { label: 'Voir les offres', href: CLOUD_PATHS.billing } as const

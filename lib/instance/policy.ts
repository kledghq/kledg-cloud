/**
 * Instance policy: the server side extension point of an instance.
 *
 * kledg-cloud override: the hosted service (KLEDG_CLOUD_MODE=true) opens
 * sign-up and company creation to users within their plan, makes the
 * companies of a read-only account read-only, requires confirmed addresses
 * and sends account deletion through its own page (lib/cloud/policy.ts for
 * the pure rules, lib/cloud/enforcement.ts for those reading the database,
 * loaded lazily so the request proxy never imports it). Without the flag
 * every answer is Kledg's own. Keep this file a thin delegation so merges
 * from Kledg stay trivial. See docs/extension-points.md and docs/cloud.md.
 */

import { isCloudMode } from '@/lib/cloud/config'
import {
  CLOUD_PUBLIC_PAGES,
  CLOUD_RATE_LIMITS,
  CLOUD_SELF_AUTHENTICATED_API_ROUTES,
  cloudIsActionAllowed,
  cloudRefusalMessage,
} from '@/lib/cloud/policy'
import type { ActionRefusal, InstanceAction, InstanceActor, RateLimitRule } from './types'

/**
 * Whether `actor` may perform `action` on this instance. `actor` is null for
 * anonymous requests (password reset request, first-run setup, emails).
 */
export async function isActionAllowed(action: InstanceAction, actor: InstanceActor | null = null): Promise<boolean> {
  return cloudIsActionAllowed(action, actor)
}

/** French message of the 403 answered when `action` is refused. */
export function actionRefusalMessage(action: InstanceAction): string {
  return cloudRefusalMessage(action)
}

/**
 * Whether `actor` may create a company (creation wizard, SIREN prefill,
 * POST /api/companies): null when they may, else why not. A user who is not
 * an instance administrator becomes the administrator of the company they
 * create. Kledg: instance administrators only. Cloud: users too, within the
 * limit of their plan or trial, while their account is not read-only.
 */
export async function companyCreationRefusal(actor: InstanceActor): Promise<ActionRefusal | null> {
  if (!isCloudMode()) {
    return actor.role === 'admin' ? null : { message: "La création de sociétés est réservée aux administrateurs de l'instance." }
  }
  const { cloudCompanyCreationRefusal } = await import('@/lib/cloud/enforcement')
  return cloudCompanyCreationRefusal(actor)
}

/**
 * Called once `actor` created the company `companyId` (after it is ready).
 * Throwing removes the company and fails the request
 * (lib/companies/create-company.service.ts). Kledg: nothing. Cloud:
 * records which account owns it.
 */
export async function afterCompanyCreated(companyId: string, actor: InstanceActor): Promise<void> {
  if (!isCloudMode()) return
  const { cloudAfterCompanyCreated } = await import('@/lib/cloud/enforcement')
  await cloudAfterCompanyCreated(companyId, actor)
}

/**
 * Why the data of company `companyId` may not change now (a read-only
 * company: an unpaid subscription, for instance), or null. Checked on every
 * write of a company route and of an MCP tool, after the archive check
 * (lib/companies/archive-company.service.ts); reads and exports stay open.
 * Kledg: never refused. Cloud: refused once the owning account is read-only.
 */
export async function companyWriteRefusal(companyId: string): Promise<ActionRefusal | null> {
  if (!isCloudMode()) return null
  const { cloudCompanyWriteRefusal } = await import('@/lib/cloud/enforcement')
  return cloudCompanyWriteRefusal(companyId)
}

/**
 * Companies whose SIREN and establishment SIRETs a company must not repeat,
 * as ids, or null for every company of the instance. `companyId` is the
 * company being changed (null for a creation), `actor` the user creating it
 * (null when unknown). Checked when a company is created or its SIREN
 * changes, and when an establishment is added or its SIRET changes
 * (lib/companies/identifiers.ts). A service whose customers share one
 * database narrows it to the customer's own companies, so that no customer
 * blocks or learns another's identifiers. Kledg: null, one organisation per
 * instance. Cloud: the companies of the same billing account (the
 * operator's companies among themselves), KLEDG-R3-CLOUD-01.
 */
export async function companyIdentifierScope(
  companyId: string | null,
  actor: Pick<InstanceActor, 'id' | 'role'> | null,
): Promise<string[] | null> {
  if (!isCloudMode()) return null
  const { cloudCompanyIdentifierScope } = await import('@/lib/cloud/enforcement')
  return cloudCompanyIdentifierScope(companyId, actor)
}

/**
 * Whether company slugs (the readable segment of company URLs) end with a
 * random suffix, generated ones and those chosen by users alike. Slugs stay
 * unique across the instance; with the suffix, an answer never depends on
 * the slugs of companies the user cannot see. Kledg: false, slugs are
 * derived from the name and numbered on collision. Cloud: yes, customers
 * share the instance (KLEDG-R3-CLOUD-01).
 */
export function randomCompanySlugSuffix(): boolean {
  return isCloudMode()
}

/**
 * Whether this instance must run with row level security (KLEDG_RLS=enforce,
 * docs/rls.md). When true and the policies are off, the server refuses to
 * start (instrumentation.ts) and the database client refuses to open
 * (lib/prisma.ts), so no request is served without them. Kledg: false.
 */
export function requiresRowLevelSecurity(env: Record<string, string | undefined> = process.env): boolean {
  void env
  return false
}

/**
 * API paths served by routes that authenticate requests themselves, with
 * the reason. A path covers itself and the paths under it, on segment
 * boundaries (lib/instance/api-paths.ts). The proxy lets them
 * through without a session and the route architecture test
 * (lib/api/__tests__/routes.test.ts) accepts their handlers unwrapped.
 * Cloud: sign-up, the Stripe webhook and the maintenance cron (404 outside
 * cloud mode).
 */
export const SELF_AUTHENTICATED_API_ROUTES: Readonly<Record<string, string>> = CLOUD_SELF_AUTHENTICATED_API_ROUTES

/**
 * Whether accounts must confirm their email address before they can sign in
 * (Better Auth's requireEmailVerification, lib/auth.ts): an unconfirmed
 * account is refused at sign-in and the attempt sends the confirmation link
 * again. Member accounts created from a company's Membres page are marked
 * confirmed (their welcome link proves the address); other accounts confirm
 * at their first sign-in. Kledg: no. Cloud: yes (public sign-up).
 */
export const REQUIRE_EMAIL_VERIFICATION: boolean = isCloudMode()

/**
 * Rate limit rules of the instance's own routes, by name, used like Kledg's
 * (`enforceRateLimit(name, subject)`, lib/rate-limit.ts). A name Kledg
 * already uses keeps Kledg's rule. Cloud: the rules of its own routes.
 */
export const INSTANCE_RATE_LIMITS = CLOUD_RATE_LIMITS satisfies Record<string, RateLimitRule>

/**
 * Pages of the instance that open without a session (a sign-up page, legal
 * notices), as paths: each one and the paths under it. The proxy lets them
 * through like /login; each page decides for itself what it shows.
 * Cloud: /signup and /legal.
 */
export const PUBLIC_PAGES: readonly string[] = isCloudMode() ? CLOUD_PUBLIC_PAGES : []

/**
 * Where to send a visitor of /setup without the installation link while
 * the instance has no administrator yet (a hosted service before launch:
 * its waitlist), instead of the neutral "Installation en cours" page.
 * Kledg: null, the neutral page. Cloud: the waitlist on the website.
 */
export const SETUP_PENDING_REDIRECT: string | null = isCloudMode() ? 'https://www.kledg.com/fr/waitlist' : null

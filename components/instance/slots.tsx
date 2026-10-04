/**
 * Instance UI slots: the interface side extension point of an instance.
 *
 * kledg-cloud override: with KLEDG_CLOUD_MODE=true the slots render the
 * hosted service's banner (terms to accept, trial and subscription state),
 * the sign-up prompt of the login page, and add the "Facturation" and
 * "Données et compte" pages (and the operator console for instance
 * administrators) to the settings navigation. Without the flag they render
 * nothing, like in Kledg. The components live in components/cloud; keep
 * this file a thin delegation so merges from Kledg stay trivial. See
 * docs/extension-points.md and docs/cloud.md.
 */

import type { InstanceActor } from '@/lib/instance/types'
import type { UserMenuItem } from '@/components/layout/user-menu'
import type { InstanceSettingsLinks, InstanceSettingsPage } from '@/components/layout/settings-nav-config'
import { CLOUD_PATHS, isCloudMode } from '@/lib/cloud/config'
import { CloudBanner } from '@/components/cloud/cloud-banner'
import { SignupPrompt } from '@/components/cloud/signup-prompt'
import { CloudAnalytics } from '@/components/cloud/cloud-analytics'

/** Above the header of every page of the application frame (company and settings pages). */
export function InstanceBanner({ user }: { user: InstanceActor }) {
  return isCloudMode() ? <CloudBanner user={user} /> : null
}

/**
 * Above the sign-in card on /login. `redirectTo` is the checked same-origin
 * path to open after signing in.
 */
export function LoginExtra(props: { redirectTo: string }) {
  void props
  return isCloudMode() ? <SignupPrompt /> : null
}

/**
 * After the content of company pages (a client component reads the company
 * from the URL with useParams). Floating UI goes bottom right: the account
 * menu opens bottom left. Give its root the `data-instance-overlay`
 * attribute so it stays usable above the statement import dialog.
 */
export function CompanyOverlay(props: { user: InstanceActor }) {
  void props
  return null
}

/**
 * At the end of <body> on every page, signed in or not (an analytics or
 * status script of the instance). `nonce` is the page CSP nonce, for a
 * script the slot renders inline. Kledg: nothing, no tracking. Cloud:
 * Vercel Web Analytics, cookieless, without company names, ids or query
 * strings in the paths.
 */
export function InstanceDocumentEnd(props: { nonce?: string }) {
  void props
  return isCloudMode() ? <CloudAnalytics /> : null
}

/** The user menu entries (and the matching settings links) shown to `user`. */
export async function filterUserMenu(items: UserMenuItem[], user: InstanceActor): Promise<UserMenuItem[]> {
  void user
  return items
}

/**
 * The instance's own versions of the administrators' pages for `user`, who
 * is not an instance administrator, by user menu entry ("instance", "users",
 * "updates"...): the settings sidebar then shows the "Instance" group with
 * these links (and the version line links to "updates"). Kledg: none.
 */
export async function instanceSettingsLinks(user: InstanceActor): Promise<InstanceSettingsLinks | null> {
  void user
  return null
}

/**
 * The instance's own settings pages for `user` (a billing page, an operator
 * console), added to the settings sidebar and breadcrumb: at the end of the
 * "Compte" group, or of the "Instance" group (instance administrators).
 * Kledg: none. Cloud: Facturation and Données et compte for customers, the
 * operator console for instance administrators.
 */
export async function instanceSettingsPages(user: InstanceActor): Promise<InstanceSettingsPage[]> {
  if (!isCloudMode()) return []
  if (user.role === 'admin') return [{ group: 'instance', title: 'Console Kledg Cloud', url: CLOUD_PATHS.console, icon: 'gauge' }]
  return [
    { group: 'account', title: 'Facturation', url: CLOUD_PATHS.billing, icon: 'credit-card' },
    { group: 'account', title: 'Données et compte', url: CLOUD_PATHS.data, icon: 'download' },
  ]
}

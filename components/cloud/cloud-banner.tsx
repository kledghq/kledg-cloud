import Link from 'next/link'
import type { InstanceActor } from '@/lib/instance/types'
import { cn } from '@/lib/utils'
import { accessOf, findBillingAccount } from '@/lib/cloud/billing/billing-account.service'
import { billingNotice } from '@/lib/cloud/billing/notice'
import { pendingTerms } from '@/lib/cloud/legal/terms-acceptance.service'
import { currentTermsVersion } from '@/lib/cloud/legal/terms'
import { AcceptTermsButton } from './accept-terms-button'

/**
 * Banner of Kledg Cloud above every page of the application frame
 * (InstanceBanner slot): new terms to accept first, then the billing state
 * of the user's own account (trial, payment to fix, end of subscription,
 * read-only, deletion in progress). Nothing for an account with nothing to
 * say, for members who own no company, nor for the operator.
 */
export async function CloudBanner({ user, now = new Date() }: { user: InstanceActor; now?: Date }) {
  // The operator (instance administrator) is not a customer.
  if (user.role === 'admin') return null
  const [terms, account] = await Promise.all([pendingTerms(user.id), findBillingAccount(user.id)])

  if (terms.length > 0) {
    return (
      <div role="status" className="bg-surface text-muted-foreground flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b px-4 py-1.5 text-center text-xs">
        <span>
          Nos{' '}
          <Link href="/legal/cgu" target="_blank" className="text-foreground underline underline-offset-2">
            conditions générales d&apos;utilisation
          </Link>{' '}
          et{' '}
          <Link href="/legal/cgv" target="_blank" className="text-foreground underline underline-offset-2">
            de vente
          </Link>{' '}
          évoluent. Lisez-les et acceptez-les pour continuer à utiliser Kledg.
        </span>
        <AcceptTermsButton version={currentTermsVersion()} />
      </div>
    )
  }

  if (!account) return null
  const notice = billingNotice(accessOf(account, now), account.deletionScheduledFor, now)
  if (!notice) return null
  return (
    <div
      role="status"
      data-tone={notice.tone}
      className={cn(
        'flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b px-4 py-1.5 text-center text-xs',
        notice.tone === 'warning' ? 'bg-warning/10 text-foreground' : 'bg-surface text-muted-foreground',
      )}
    >
      <span>{notice.text}</span>
      <Link href={notice.link.href} className="text-foreground font-medium underline underline-offset-2">
        {notice.link.label}
      </Link>
    </div>
  )
}

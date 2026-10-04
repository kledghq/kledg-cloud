import Link from 'next/link'
import type { InstanceActor } from '@/lib/instance/types'
import { cn } from '@/lib/utils'
import { LEGAL_URLS } from '@/lib/cloud/config'
import { accessOf, belongsToAnyCompany, findBillingAccount, virtualBillingAccount } from '@/lib/cloud/billing/billing-account.service'
import { billingNotice } from '@/lib/cloud/billing/notice'
import { pendingTerms } from '@/lib/cloud/legal/terms-acceptance.service'
import { CURRENT_TERMS, currentTermsVersion } from '@/lib/cloud/legal/terms'
import { AcceptTermsButton } from './accept-terms-button'

/**
 * Banner of Kledg Cloud above every page of the application frame
 * (InstanceBanner slot): a new CGV version to accept first, then the
 * billing state of the user's own account (how to start, trial, payment to
 * fix, end of subscription, retrieval period, read-only, deletion in
 * progress). Nothing for an account with nothing to say, for members
 * invited into someone else's companies, nor for the operator.
 */
export async function CloudBanner({ user, now = new Date() }: { user: InstanceActor; now?: Date }) {
  // The operator (instance administrator) is not a customer.
  if (user.role === 'admin') return null
  const [terms, stored, hasCompanies] = await Promise.all([pendingTerms(user.id), findBillingAccount(user.id), belongsToAnyCompany(user.id)])

  if (terms.length > 0) {
    return (
      <div role="status" className="bg-surface text-muted-foreground flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b px-4 py-1.5 text-center text-xs">
        <span>
          Nos{' '}
          <a href={LEGAL_URLS.cgv} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">
            conditions générales de vente
          </a>{' '}
          évoluent (version {CURRENT_TERMS.cgv.version}). Lisez-les et acceptez-les pour continuer à utiliser Kledg.
        </span>
        <AcceptTermsButton version={currentTermsVersion()} />
      </div>
    )
  }

  const notice = billingNotice(accessOf(stored ?? virtualBillingAccount(user.id, now), now), now, { hasCompanies })
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

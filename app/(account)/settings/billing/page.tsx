import { notFound, redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/session'
import { isCloudMode } from '@/lib/cloud/config'
import { loadBillingOverview } from '@/lib/cloud/billing/billing-overview.service'
import { PageHeader } from '@/components/shared'
import { BillingSettings } from '@/components/cloud/billing-settings'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Facturation' }

/** Kledg Cloud billing of the signed-in user's account: plan, usage, Stripe portal and invoices. */
export default async function BillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!isCloudMode()) notFound()
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const { checkout } = await searchParams
  return (
    <div className="w-full max-w-4xl space-y-6">
      <PageHeader
        title="Facturation"
        description="Votre offre, le nombre de sociétés qu'elle couvre, votre abonnement et vos factures. Le paiement et vos coordonnées de facturation sont gérés par Stripe."
      />
      <BillingSettings overview={await loadBillingOverview(user)} checkout={checkout === 'success' || checkout === 'cancel' ? checkout : null} />
    </div>
  )
}

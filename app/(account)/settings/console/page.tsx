import { notFound, redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/session'
import { isGlobalAdmin } from '@/lib/rbac/authorize'
import { isCloudMode } from '@/lib/cloud/config'
import { listOperatorAccounts } from '@/lib/cloud/operator/operator.service'
import { PageHeader } from '@/components/shared'
import { OperatorConsole } from '@/components/cloud/operator-console'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Console Kledg Cloud' }

/** Operator console (instance administrators only): accounts, plans, states, trials. */
export default async function ConsolePage() {
  if (!isCloudMode()) notFound()
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!isGlobalAdmin(user)) notFound()
  const { accounts, nextCursor } = await listOperatorAccounts({})
  return (
    <div className="space-y-6">
      <PageHeader title="Console Kledg Cloud" description="Les comptes clients, leur offre, leur état et leurs sociétés. Les abonnements se gèrent dans Stripe." />
      <OperatorConsole initial={accounts} nextCursor={nextCursor} />
    </div>
  )
}

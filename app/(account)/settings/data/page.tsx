import { notFound, redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/session'
import { isCloudMode } from '@/lib/cloud/config'
import { previewAccountDeletion } from '@/lib/cloud/account/account-deletion.service'
import { exportableCompanies } from '@/lib/cloud/export/export-company-data.service'
import { PageHeader } from '@/components/shared'
import { DataSettings } from '@/components/cloud/data-settings'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Données et compte' }

/** Kledg Cloud: full export of the user's companies, and deletion of the account. */
export default async function DataPage() {
  if (!isCloudMode()) notFound()
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const [companies, deletion] = await Promise.all([exportableCompanies(user.id), previewAccountDeletion(user)])
  return (
    <div className="w-full max-w-3xl space-y-6">
      <PageHeader
        title="Données et compte"
        description="Récupérez toutes les données de vos sociétés, ou supprimez votre compte. Vos données vous appartiennent."
      />
      <DataSettings companies={companies} deletion={deletion} email={user.email} />
    </div>
  )
}

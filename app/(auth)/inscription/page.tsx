import { notFound, redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/session'
import { cloudSettings, isCloudMode } from '@/lib/cloud/config'
import { CURRENT_TERMS, currentTermsVersion } from '@/lib/cloud/legal/terms'
import { SignupForm } from '@/components/cloud/signup-form'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Créer un compte' }

/** Public sign-up of Kledg Cloud; does not exist on other instances. */
export default async function SignupPage() {
  if (!isCloudMode()) notFound()
  if (await getCurrentUser()) redirect('/')
  return <SignupForm termsVersion={currentTermsVersion()} cgvVersion={CURRENT_TERMS.cgv.version} trialDays={cloudSettings().trialDays} />
}

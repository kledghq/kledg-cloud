import { notFound } from 'next/navigation'
import { isCloudMode } from '@/lib/cloud/config'
import { LegalPage } from '@/components/cloud/legal-page'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Informations légales' }

/** List of the legal documents of Kledg Cloud. */
export default function LegalIndexPage() {
  if (!isCloudMode()) notFound()
  return <LegalPage slug={null} document={null} />
}

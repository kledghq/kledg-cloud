import { notFound } from 'next/navigation'
import { isCloudMode } from '@/lib/cloud/config'
import { isLegalPageSlug, LEGAL_PAGES } from '@/lib/cloud/legal/terms'
import { LEGAL_DOCUMENTS } from '@/lib/cloud/legal/documents'
import { LegalPage } from '@/components/cloud/legal-page'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ document: string }> }

export async function generateMetadata({ params }: Params) {
  const { document } = await params
  return { title: isLegalPageSlug(document) ? LEGAL_PAGES[document].title : 'Informations légales' }
}

/** A legal document of Kledg Cloud (public: linked from the sign-up form and the emails). */
export default async function LegalDocumentPage({ params }: Params) {
  const { document } = await params
  if (!isCloudMode() || !isLegalPageSlug(document)) notFound()
  return <LegalPage slug={document} document={LEGAL_DOCUMENTS[document]} />
}

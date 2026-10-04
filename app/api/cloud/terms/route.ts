import { NextResponse } from 'next/server'
import { authedRoute } from '@/lib/api/route'
import { assertCloudMode } from '@/lib/cloud/http'
import { acceptCurrentTerms, AcceptTermsSchema } from '@/lib/cloud/legal/terms-acceptance.service'

/** Records that the signed-in user accepts the current CGU and CGV (banner shown after a new version). */
export const POST = authedRoute({ body: AcceptTermsSchema }, async ({ user, body }) => {
  assertCloudMode()
  return NextResponse.json(await acceptCurrentTerms(user, body))
})

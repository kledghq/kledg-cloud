import { NextResponse } from 'next/server'
import { adminRoute } from '@/lib/api/route'
import { assertSameOrigin } from '@/lib/api/same-origin'
import { assertCloudMode } from '@/lib/cloud/http'
import { extendTrial, ExtendTrialSchema } from '@/lib/cloud/operator/operator.service'

/** Operator console: extends the trial of an account by a number of days (instance administrators only). */
export const POST = adminRoute({ body: ExtendTrialSchema }, async ({ request, params, user, body }) => {
  assertCloudMode()
  assertSameOrigin(request)
  return NextResponse.json(await extendTrial(user, params.id as string, body))
})

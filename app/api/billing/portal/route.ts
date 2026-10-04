import { NextResponse } from 'next/server'
import { authedRoute } from '@/lib/api/route'
import { assertCloudMode } from '@/lib/cloud/http'
import { createPortalSession } from '@/lib/cloud/billing/checkout.service'

/** Opens the Stripe Customer Portal of the signed-in user's account; answers the URL to go to. */
export const POST = authedRoute({}, async ({ user }) => {
  assertCloudMode()
  return NextResponse.json(await createPortalSession(user))
})

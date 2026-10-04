import { NextResponse } from 'next/server'
import { authedRoute } from '@/lib/api/route'
import { assertCloudMode } from '@/lib/cloud/http'
import { CheckoutSchema, createCheckoutSession } from '@/lib/cloud/billing/checkout.service'

/** Opens a Stripe Checkout session for the signed-in user's account; answers the URL to go to. */
export const POST = authedRoute({ body: CheckoutSchema }, async ({ user, body }) => {
  assertCloudMode()
  return NextResponse.json(await createCheckoutSession(user, body))
})

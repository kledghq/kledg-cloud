import { NextResponse } from 'next/server'
import { publicCloudRoute } from '@/lib/cloud/http'
import { receiveStripeWebhook } from '@/lib/cloud/billing/stripe-webhook.service'

/**
 * Stripe webhook of Kledg Cloud (https://app.kledg.com/api/billing/webhook).
 * Authenticated by the Stripe-Signature header, checked against the raw body
 * with STRIPE_WEBHOOK_SECRET; idempotent per event id
 * (lib/cloud/billing/stripe-webhook.service.ts). 400 on a bad signature,
 * 502 when the event could not be applied (Stripe retries it).
 */
export const POST = publicCloudRoute({ maxBodyBytes: 1024 * 1024 }, async (request) => {
  const outcome = await receiveStripeWebhook(await request.text(), request.headers.get('stripe-signature'))
  return NextResponse.json({ received: true, status: outcome.status })
})

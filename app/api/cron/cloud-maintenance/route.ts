import { NextResponse } from 'next/server'
import { publicCloudRoute } from '@/lib/cloud/http'
import { assertCronRequest, runCloudMaintenance } from '@/lib/cloud/maintenance.service'

/**
 * Daily maintenance of Kledg Cloud (Vercel Cron, vercel.json): due account
 * deletions, books past their retention, unconfirmed accounts, old Stripe
 * event ids. Requires the CRON_SECRET bearer token.
 */
export const GET = publicCloudRoute({}, async (request) => {
  assertCronRequest(request)
  return NextResponse.json(await runCloudMaintenance())
})

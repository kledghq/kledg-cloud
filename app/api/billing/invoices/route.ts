import { NextResponse } from 'next/server'
import { authedRoute } from '@/lib/api/route'
import { assertCloudMode } from '@/lib/cloud/http'
import { listInvoices } from '@/lib/cloud/billing/checkout.service'

/** The signed-in user's Kledg Cloud invoices, from Stripe (newest first, 24 at most). */
export const GET = authedRoute({}, async ({ user }) => {
  assertCloudMode()
  return NextResponse.json({ invoices: await listInvoices(user) })
})

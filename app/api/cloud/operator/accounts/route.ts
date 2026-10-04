import { NextResponse } from 'next/server'
import { adminRoute } from '@/lib/api/route'
import { assertCloudMode } from '@/lib/cloud/http'
import { listOperatorAccounts, OperatorListQuery } from '@/lib/cloud/operator/operator.service'

/** Operator console: billing accounts, newest first (instance administrators only). */
export const GET = adminRoute({ query: OperatorListQuery }, async ({ query }) => {
  assertCloudMode()
  return NextResponse.json(await listOperatorAccounts(query))
})

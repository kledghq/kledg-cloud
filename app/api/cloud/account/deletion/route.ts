import { NextResponse } from 'next/server'
import { authedRoute } from '@/lib/api/route'
import { assertSameOrigin } from '@/lib/api/same-origin'
import { assertCloudMode } from '@/lib/cloud/http'
import {
  cancelAccountDeletion,
  previewAccountDeletion,
  scheduleAccountDeletion,
  ScheduleDeletionSchema,
} from '@/lib/cloud/account/account-deletion.service'

/** What deleting the signed-in user's account would do: companies, books kept, blockers, scheduled date. */
export const GET = authedRoute({}, async ({ user }) => {
  assertCloudMode()
  return NextResponse.json(await previewAccountDeletion(user))
})

/** Schedules the deletion after the grace period (address and password confirmed). */
export const POST = authedRoute({ body: ScheduleDeletionSchema }, async ({ request, user, body }) => {
  assertCloudMode()
  assertSameOrigin(request)
  return NextResponse.json(await scheduleAccountDeletion(user, body))
})

/** Cancels a scheduled deletion. */
export const DELETE = authedRoute({}, async ({ request, user }) => {
  assertCloudMode()
  assertSameOrigin(request)
  return NextResponse.json(await cancelAccountDeletion(user))
})

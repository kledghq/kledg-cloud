/**
 * HTTP helpers of Kledg Cloud routes.
 *
 * - `assertCloudMode`: every hosted-service route answers 404 outside cloud
 *   mode, like a route that does not exist.
 * - `publicCloudRoute`: the wrapper of the few routes that authenticate
 *   requests themselves (sign-up, Stripe webhook, maintenance cron, declared
 *   in lib/cloud/policy.ts): cloud mode, body size cap and the error mapping
 *   of Kledg's route wrappers (lib/api/route.ts), so a handler never builds
 *   an error response by hand.
 */

import { NextRequest } from 'next/server'
import { NotFoundError } from '@/lib/accounting/errors'
import { toErrorResponse } from '@/lib/api/errors'
import { guardRequest } from '@/lib/api/request-guards'
import { isCloudMode } from './config'

export function assertCloudMode(): void {
  if (!isCloudMode()) throw new NotFoundError('Page introuvable')
}

type PublicHandler = (request: NextRequest) => Promise<Response>

export function publicCloudRoute(options: { maxBodyBytes?: number }, handler: PublicHandler) {
  return async (request: Request): Promise<Response> => {
    try {
      assertCloudMode()
      const incoming = 'nextUrl' in request ? (request as NextRequest) : new NextRequest(request)
      return await handler(await guardRequest(incoming, { maxBodyBytes: options.maxBodyBytes }))
    } catch (error) {
      return toErrorResponse(error)
    }
  }
}

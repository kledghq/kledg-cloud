import { NextResponse } from 'next/server'
import { UnsupportedMediaTypeError } from '@/lib/accounting/errors'
import { parseInput } from '@/lib/api/zod-fields'
import { clientIpOrUnknown } from '@/lib/client-ip'
import { publicCloudRoute } from '@/lib/cloud/http'
import { requestSignup, SignupSchema } from '@/lib/cloud/signup/signup.service'

/**
 * Public sign-up of Kledg Cloud (lib/cloud/signup/signup.service.ts). JSON
 * only, so a cross-site form cannot post here without a CORS preflight.
 * Always 202 with the same body once the input is valid: whether the
 * address already has an account is told by email only.
 */
export const POST = publicCloudRoute({ maxBodyBytes: 16 * 1024 }, async (request) => {
  if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new UnsupportedMediaTypeError('Type de contenu refusé : envoyez du JSON (Content-Type: application/json).')
  }
  const body = parseInput(SignupSchema, await request.json().catch(() => null))
  await requestSignup(body, clientIpOrUnknown(request.headers))
  return NextResponse.json(
    { ok: true, message: 'Vérifiez votre boîte mail : nous vous avons envoyé un lien pour finaliser votre inscription.' },
    { status: 202 },
  )
})

/**
 * Public sign-up of Kledg Cloud (POST /api/signup, page /signup).
 *
 * Written assuming the attacker reads this code:
 * - No account enumeration. The answer is the same, and immediate, whether
 *   the address has an account or not: the work (password hash, account
 *   creation, emails) runs after the response (waitUntil). A new address
 *   gets a confirmation link; an address that already has an account gets
 *   an email saying so, and nothing is created. Only the owner of the
 *   mailbox learns which case it was.
 * - No use before the address is confirmed: Better Auth refuses to sign in
 *   an unconfirmed account (REQUIRE_EMAIL_VERIFICATION in cloud mode), and
 *   unconfirmed accounts are deleted after a few days (maintenance job).
 * - Rate limits per client IP and per address (hashed: the rate limit table
 *   never stores an address), checked before anything else, the same way
 *   for known and unknown addresses.
 * - A honeypot field: a form filled by a bot gets the usual answer and
 *   creates nothing.
 * - The CGV must be accepted, in the version currently published (1.0,
 *   https://www.kledg.com/fr/terms); the acceptance is stored with its
 *   version and date.
 * - Closed until the operator's own account exists (first-run setup):
 *   nobody can take the instance before its administrator.
 *
 * Better Auth's own sign-up endpoint stays disabled (lib/auth.ts): accounts
 * are created here, server side, through the admin plugin like the
 * first-run setup does.
 */

import { createHash } from 'node:crypto'
import { waitUntil } from '@vercel/functions'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { withAnonymousContext, withUserContext } from '@/lib/rls/context'
import { sendEmail } from '@/lib/email'
import { getAppUrl } from '@/lib/config'
import { logger } from '@/lib/logger'
import { needsSetup } from '@/lib/setup'
import { enforceRateLimit } from '@/lib/rate-limit'
import { ConflictError } from '@/lib/accounting/errors'
import { CLOUD_PATHS } from '../config'
import { accountExistsEmail } from '../email-templates'
import { currentTermsVersion } from '../legal/terms'
import { recordTermsAcceptance } from '../legal/terms-acceptance.service'

/** Better Auth's limits (lib/auth.ts: minPasswordLength 10, its default maximum 128). */
const PASSWORD_MIN = 10
const PASSWORD_MAX = 128

export const SignupSchema = z.object({
  email: z
    .string({ error: "L'adresse email est requise." })
    .trim()
    .toLowerCase()
    .max(254, 'Adresse email trop longue.')
    .pipe(z.email({ error: 'Adresse email invalide.' })),
  password: z
    .string({ error: 'Le mot de passe est requis.' })
    .min(PASSWORD_MIN, `Le mot de passe doit compter au moins ${PASSWORD_MIN} caractères.`)
    .max(PASSWORD_MAX, 'Le mot de passe est trop long.'),
  name: z.string().trim().max(100, 'Nom trop long.').optional().default(''),
  acceptTerms: z.literal(true, { error: 'Acceptez les conditions générales pour créer un compte.' }),
  termsVersion: z.string({ error: 'Version des conditions manquante.' }).max(200),
  /** Honeypot: hidden from people, filled by bots. */
  website: z.string().max(500).optional().default(''),
})
export type SignupInput = z.infer<typeof SignupSchema>

/** Rate limit subject of an address: a hash, so the counters table holds no address. */
export function addressKey(email: string): string {
  return createHash('sha256').update(`kledg-cloud-signup:${email}`).digest('hex').slice(0, 32)
}

/**
 * Checks the request and schedules the sign-up after the response. Throws
 * only for what does not depend on the address having an account: invalid
 * input, outdated terms, rate limits, sign-up not open yet.
 */
export async function requestSignup(input: SignupInput, clientIp: string, now: Date = new Date()): Promise<void> {
  await enforceRateLimit('cloud-signup-ip', clientIp)
  await enforceRateLimit('cloud-signup-email', addressKey(input.email))
  if (input.termsVersion !== currentTermsVersion()) {
    throw new ConflictError('Les conditions générales ont changé entre-temps. Rechargez la page pour lire la nouvelle version.')
  }
  if (await needsSetup()) throw new ConflictError("Les inscriptions ne sont pas encore ouvertes. Réessayez plus tard.")
  if (input.website) {
    logger.warn('Sign-up honeypot filled, ignored')
    return
  }
  waitUntil(processSignup(input, now).catch((error: unknown) => logger.error('Sign-up failed after the response', { error })))
}

export type SignupOutcome = 'created' | 'exists'

const isAlreadyExists = (error: unknown) => {
  const body = (error as { body?: { code?: unknown } } | null)?.body
  return (
    (typeof body?.code === 'string' && body.code.includes('ALREADY_EXISTS')) ||
    (error instanceof Error && /already exists|P2002|Unique constraint/i.test(error.message))
  )
}

/** The work after the response: create the account and send its link, or tell the owner it exists. */
export async function processSignup(input: SignupInput, now: Date = new Date()): Promise<SignupOutcome> {
  // Runs after the response, with no session: anonymous for Better Auth's
  // tables (like the first-run setup), the new user for its own rows (docs/rls.md).
  return withAnonymousContext(() => processSignupSteps(input, now))
}

async function processSignupSteps(input: SignupInput, now: Date): Promise<SignupOutcome> {
  const loginUrl = `${getAppUrl()}/login`
  const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } })
  if (existing) {
    await sendEmail(accountExistsEmail(input.email, loginUrl))
    return 'exists'
  }

  let userId: string
  try {
    const created = await auth.api.createUser({
      body: { email: input.email, password: input.password, name: input.name || input.email.split('@')[0], role: 'user' },
    })
    userId = created.user.id
  } catch (error) {
    // Two sign-ups of the same address at once: the second one is "exists".
    if (!isAlreadyExists(error)) throw error
    await sendEmail(accountExistsEmail(input.email, loginUrl))
    return 'exists'
  }

  // The CGV version accepted and its date (the trial itself starts at Checkout, with a plan).
  await withUserContext(userId, () => recordTermsAcceptance(userId, now))
  // Better Auth signs the link and calls the verification email hook of lib/auth.ts.
  await auth.api.sendVerificationEmail({ body: { email: input.email, callbackURL: CLOUD_PATHS.signupVerified } })
  return 'created'
}

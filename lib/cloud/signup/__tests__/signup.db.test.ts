/**
 * Public sign-up of Kledg Cloud (POST /api/signup) against PostgreSQL,
 * through the real route, Better Auth and the policy in cloud mode; only
 * email delivery and waitUntil are replaced:
 * - a new address gets an unconfirmed account, its CGV acceptance with
 *   version and date, and a confirmation link (no trial yet: it starts at
 *   Checkout, with a plan); the account cannot
 *   sign in until the link is followed;
 * - an address that has an account gets the very same answer, and an email
 *   saying so instead of a link: nothing tells them apart over HTTP;
 * - invalid input, outdated terms, non-JSON bodies, the honeypot, rate
 *   limits per address and per IP, an instance not set up yet, and the
 *   route outside cloud mode.
 *
 * Skipped when the test database server is unreachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = await vi.hoisted(async () => {
  const { useTestDatabase } = await import('@/lib/__tests__/helpers/test-db')
  useTestDatabase('cloud_signup')
  // Read when the policy and Better Auth load: cloud mode requires confirmed addresses.
  process.env.KLEDG_CLOUD_MODE = 'true'
  process.env.BETTER_AUTH_SECRET ??= 'kledg-test-secret-0123456789abcdef0123456789'
  process.env.BETTER_AUTH_URL = 'http://localhost:3000'
  process.env.RATE_LIMIT_DISABLED = 'true'
  return { background: [] as Promise<unknown>[], emails: [] as Array<{ to: string; subject: string; text: string }> }
})

vi.mock('@vercel/functions', () => ({ waitUntil: (promise: Promise<unknown>) => state.background.push(promise) }))
vi.mock('@/lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email')>()),
  sendEmail: vi.fn(async (message: { to: string; subject: string; text: string }) => {
    state.emails.push(message)
  }),
}))

import { prepareTestDatabase, testDatabaseAvailable } from '@/lib/__tests__/helpers/test-db'
import { currentTermsVersion, CURRENT_TERMS } from '@/lib/cloud/legal/terms'

const available = await testDatabaseAvailable()

let prisma: typeof import('@/lib/prisma').prisma
let POST: (request: Request) => Promise<Response>
let auth: typeof import('@/lib/auth').auth

const valid = (over: Record<string, unknown> = {}) => ({
  email: 'Claire.Martin@Example.test',
  password: 'un-mot-de-passe-solide',
  name: 'Claire Martin',
  acceptTerms: true,
  termsVersion: currentTermsVersion(),
  ...over,
})

function signup(body: unknown, options: { contentType?: string; ip?: string } = {}) {
  return POST(
    new NextRequest('http://localhost/api/signup', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': options.contentType ?? 'application/json', 'x-real-ip': options.ip ?? '203.0.113.10' },
    }),
  )
}

async function settle() {
  const pending = state.background.splice(0)
  await Promise.all(pending)
}


describe.skipIf(!available)('public sign-up', () => {
  beforeAll(async () => {
    await prepareTestDatabase('cloud_signup')
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ auth } = await import('@/lib/auth'))
    ;({ POST } = (await import('@/app/api/signup/route')) as unknown as { POST: typeof POST })
  }, 120_000)

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  beforeEach(() => {
    vi.stubEnv('KLEDG_CLOUD_MODE', 'true')
    vi.stubEnv('VERCEL', '1')
    state.emails.length = 0
  })

  it('stays closed until the operator account exists (first-run setup)', async () => {
    expect(await prisma.user.count()).toBe(0)
    const response = await signup(valid())
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Les inscriptions ne sont pas encore ouvertes. Réessayez plus tard.' })
    await prisma.user.create({ data: { id: 'u-operator', email: 'operator@test.local', name: 'Opérateur', role: 'admin', emailVerified: true } })
  })

  it('creates an unconfirmed account with its CGV acceptance (version 1.1 and date), and sends the confirmation link', async () => {
    const response = await signup(valid())
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      ok: true,
      message: 'Vérifiez votre boîte mail : nous vous avons envoyé un lien pour finaliser votre inscription.',
    })
    await settle()

    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'claire.martin@example.test' }, include: { accounts: true } })
    expect(user).toMatchObject({ name: 'Claire Martin', role: 'user', emailVerified: false })
    expect(user.accounts.map((a) => a.providerId)).toEqual(['credential'])
    expect(user.accounts[0].password).not.toContain('un-mot-de-passe-solide')

    const acceptances = await prisma.cloudTermsAcceptance.findMany({ where: { userId: user.id }, orderBy: { document: 'asc' } })
    expect(acceptances.map((a) => [a.document, a.version])).toEqual([['cgv', '1.1']])
    expect(CURRENT_TERMS.cgv).toEqual({ version: '1.1', effective: '2026-10-08' })
    expect(Math.abs(acceptances[0].acceptedAt.getTime() - Date.now())).toBeLessThan(60_000)

    // No billing account yet: the trial starts when a plan is chosen.
    expect(await prisma.cloudBillingAccount.count({ where: { ownerUserId: user.id } })).toBe(0)

    expect(state.emails.map((e) => [e.to, e.subject])).toEqual([['claire.martin@example.test', 'Confirmez votre adresse email Kledg']])
    expect(state.emails[0].text).toMatch(/http:\/\/localhost:3000\/api\/auth\/verify-email\?token=[^&\s]+&callbackURL=%2Finscription%2Fconfirmee/)
  })

  it('refuses to sign the account in before the address is confirmed, sends the link again, and lets it in after', async () => {
    const credentials = { email: 'claire.martin@example.test', password: 'un-mot-de-passe-solide' }
    await expect(auth.api.signInEmail({ body: credentials })).rejects.toMatchObject({ body: { code: 'EMAIL_NOT_VERIFIED' } })
    await settle()
    const link = /(http:\/\/localhost:3000\/api\/auth\/verify-email\?\S+)/.exec(state.emails.at(-1)?.text ?? '')?.[1]
    expect(link).toBeDefined()

    // The link sent at sign-in opens the root page (which then asks to sign in); no session is created by the link.
    const verified = await auth.handler(new Request(link!))
    expect(verified.status).toBe(302)
    expect(verified.headers.get('location')).toBe('/')
    expect(verified.headers.get('set-cookie') ?? '').not.toMatch(/session_token=[^;]+/)
    expect((await prisma.user.findUniqueOrThrow({ where: { email: credentials.email } })).emailVerified).toBe(true)
    await expect(auth.api.signInEmail({ body: credentials })).resolves.toMatchObject({ user: { email: credentials.email } })
  })

  it('answers an address that has an account exactly like a new one, and tells its owner by email only', async () => {
    const fresh = await signup(valid({ email: 'nouveau@example.test' }))
    const known = await signup(valid({ password: 'un-autre-mot-de-passe' }))
    expect(known.status).toBe(fresh.status)
    expect(await known.json()).toEqual(await fresh.json())
    await settle()
    const sent = Object.fromEntries(state.emails.map((e) => [e.to, e.subject]))
    expect(sent).toEqual({
      'nouveau@example.test': 'Confirmez votre adresse email Kledg',
      'claire.martin@example.test': 'Votre compte Kledg existe déjà',
    })
    // The existing account is untouched: same password, no second account.
    await expect(auth.api.signInEmail({ body: { email: 'claire.martin@example.test', password: 'un-mot-de-passe-solide' } })).resolves.toBeDefined()
    expect(await prisma.user.count({ where: { email: 'claire.martin@example.test' } })).toBe(1)
  })

  it('creates one account for two simultaneous sign-ups of the same address', async () => {
    const [a, b] = await Promise.all([signup(valid({ email: 'double@example.test' })), signup(valid({ email: 'double@example.test' }))])
    expect([a.status, b.status]).toEqual([202, 202])
    await settle()
    expect(await prisma.user.count({ where: { email: 'double@example.test' } })).toBe(1)
    expect(state.emails.filter((e) => e.to === 'double@example.test').map((e) => e.subject).sort()).toEqual([
      'Confirmez votre adresse email Kledg',
      'Votre compte Kledg existe déjà',
    ])
  })

  it('validates the input in French, and requires the current terms', async () => {
    const cases: Array<[unknown, number, string]> = [
      [valid({ acceptTerms: false }), 400, 'acceptTerms: Acceptez les conditions générales pour créer un compte.'],
      [valid({ password: 'court' }), 400, 'password: Le mot de passe doit compter au moins 10 caractères.'],
      [valid({ email: 'pas-une-adresse' }), 400, 'email: Adresse email invalide.'],
      [valid({ termsVersion: 'cgv:0.9' }), 409, 'Les conditions générales ont changé entre-temps. Rechargez la page pour lire la nouvelle version.'],
    ]
    for (const [body, status, error] of cases) {
      const response = await signup(body)
      expect(response.status).toBe(status)
      expect(((await response.json()) as { error: string }).error).toBe(error)
    }
    const form = await signup('email=a%40b.test&password=x', { contentType: 'application/x-www-form-urlencoded' })
    expect(form.status).toBe(415)
    await settle()
    expect(state.emails).toEqual([])
  })

  it('answers a filled honeypot like a real sign-up and creates nothing', async () => {
    const response = await signup(valid({ email: 'robot@example.test', website: 'https://spam.example' }))
    expect(response.status).toBe(202)
    await settle()
    expect(await prisma.user.count({ where: { email: 'robot@example.test' } })).toBe(0)
    expect(state.emails).toEqual([])
  })

  it('limits attempts per address (known or not) and per IP, in French, before any work', async () => {
    vi.stubEnv('RATE_LIMIT_DISABLED', '')
    try {
      for (const email of ['claire.martin@example.test', 'inconnu@example.test']) {
        const statuses = []
        for (let i = 0; i < 4; i++) statuses.push((await signup(valid({ email }), { ip: `198.51.100.${i}` })).status)
        expect(statuses).toEqual([202, 202, 202, 429])
      }
      const limited = await signup(valid({ email: 'claire.martin@example.test' }), { ip: '198.51.100.99' })
      expect(await limited.json()).toEqual({ error: 'Trop de demandes pour cette adresse. Réessayez dans une heure.' })
      // The counters hold no address.
      expect(await prisma.rateLimit.count({ where: { key: { contains: 'example.test' } } })).toBe(0)

      const ipStatuses = []
      for (let i = 0; i < 11; i++) ipStatuses.push((await signup(valid({ email: `ip${i}@example.test` }), { ip: '192.0.2.77' })).status)
      expect(ipStatuses.slice(0, 10).every((s) => s === 202)).toBe(true)
      expect(ipStatuses[10]).toBe(429)
    } finally {
      await settle()
      vi.stubEnv('RATE_LIMIT_DISABLED', 'true')
    }
  })

  it('[KLEDG-R3-CLOUD-07] counts one mailbox whatever its +tag or Gmail dots, and one IPv6 subscriber per /64', async () => {
    const { addressKey, mailboxOf } = await import('@/lib/cloud/signup/signup.service')
    expect(mailboxOf('Victim+1@Example.test')).toBe('victim@example.test')
    expect(mailboxOf('v.i.c.t.i.m+news@googlemail.com')).toBe('victim@gmail.com')
    expect(mailboxOf('v.ictim@example.test')).toBe('v.ictim@example.test')
    expect(addressKey('a+1@x.fr')).toBe(addressKey('a@x.fr'))
    expect(addressKey('Jean.Dupont@gmail.com')).toBe(addressKey('jeandupont+kledg@gmail.com'))

    vi.stubEnv('RATE_LIMIT_DISABLED', '')
    try {
      const statuses = []
      for (let i = 0; i < 4; i++) statuses.push((await signup(valid({ email: `boite+${i}@example.test` }), { ip: `198.51.100.${20 + i}` })).status)
      expect(statuses).toEqual([202, 202, 202, 429])

      const ipStatuses = []
      for (let i = 0; i < 11; i++) {
        ipStatuses.push((await signup(valid({ email: `v6-${i}@example.test` }), { ip: `2001:db8:77:1:${(i + 1).toString(16)}::1` })).status)
      }
      expect(ipStatuses.slice(0, 10).every((status) => status === 202)).toBe(true)
      expect(ipStatuses[10]).toBe(429)
    } finally {
      await settle()
      vi.stubEnv('RATE_LIMIT_DISABLED', 'true')
    }
  })

  it('[KLEDG-R3-CLOUD-07] caps the sign-up emails of the whole instance per hour', async () => {
    vi.stubEnv('RATE_LIMIT_DISABLED', '')
    try {
      // The hour's cap already reached by other clients.
      const { RATE_LIMIT_RULES } = await import('@/lib/rate-limit')
      await prisma.rateLimit.upsert({
        where: { key: 'cloud-signup-global|all' },
        create: { id: 'rl-global', key: 'cloud-signup-global|all', count: RATE_LIMIT_RULES['cloud-signup-global'].max, lastRequest: BigInt(Date.now()) },
        update: { count: RATE_LIMIT_RULES['cloud-signup-global'].max, lastRequest: BigInt(Date.now()) },
      })
      const refused = await signup(valid({ email: 'plafond@example.test' }), { ip: '198.51.100.200' })
      expect(refused.status).toBe(429)
      expect(await refused.json()).toEqual({ error: 'Trop de créations de compte en ce moment. Réessayez dans une heure.' })
      await settle()
      expect(state.emails).toEqual([])
    } finally {
      await prisma.rateLimit.deleteMany({ where: { key: 'cloud-signup-global|all' } })
      vi.stubEnv('RATE_LIMIT_DISABLED', 'true')
    }
  })

  it('does not exist outside cloud mode', async () => {
    vi.stubEnv('KLEDG_CLOUD_MODE', '')
    expect((await signup(valid({ email: 'hors-cloud@example.test' }))).status).toBe(404)
  })
})

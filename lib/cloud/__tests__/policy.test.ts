/**
 * Instance policy of Kledg Cloud (lib/cloud/policy.ts, plugged in by
 * lib/instance/policy.ts): what changes in cloud mode, and that nothing
 * does without it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { INSTANCE_ACTIONS } from '@/lib/instance/types'
import { CLOUD_PUBLIC_PAGES, CLOUD_RATE_LIMITS, CLOUD_REFUSED, CLOUD_SELF_AUTHENTICATED_API_ROUTES, cloudIsActionAllowed, cloudRefusalMessage, DEFAULT_REFUSAL } from '../policy'

const user = { id: 'u1', email: 'user@test.local', role: 'user' }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('Kledg Cloud policy', () => {
  it('allows every action outside cloud mode, with Kledg default message', async () => {
    vi.stubEnv('KLEDG_CLOUD_MODE', '')
    for (const action of INSTANCE_ACTIONS) expect(await cloudIsActionAllowed(action, user)).toBe(true)
    expect(cloudRefusalMessage('delete-account')).toBe(DEFAULT_REFUSAL)
  })

  it('sends account deletion to its own page in cloud mode, and allows everything else', async () => {
    vi.stubEnv('KLEDG_CLOUD_MODE', 'true')
    expect(await cloudIsActionAllowed('delete-account', user)).toBe(false)
    expect(cloudRefusalMessage('delete-account')).toBe(CLOUD_REFUSED['delete-account'])
    expect(cloudRefusalMessage('delete-account')).toMatch(/^Supprimez votre compte depuis la page Données et compte :/)
    for (const action of INSTANCE_ACTIONS.filter((a) => a !== 'delete-account')) {
      expect(await cloudIsActionAllowed(action, user)).toBe(true)
    }
  })

  it('declares its public routes and pages with a reason', () => {
    expect(Object.keys(CLOUD_SELF_AUTHENTICATED_API_ROUTES)).toEqual(['/api/signup', '/api/billing/webhook', '/api/cron/cloud-maintenance'])
    for (const reason of Object.values(CLOUD_SELF_AUTHENTICATED_API_ROUTES)) expect(reason.length).toBeGreaterThan(20)
    expect(CLOUD_PUBLIC_PAGES).toEqual(['/signup'])
    expect(Object.keys(CLOUD_RATE_LIMITS).every((name) => name.startsWith('cloud-'))).toBe(true)
  })

  it('is what the instance policy answers in cloud mode, and Kledg defaults without it', async () => {
    vi.stubEnv('KLEDG_CLOUD_MODE', 'true')
    const cloud = await import('@/lib/instance/policy')
    expect(cloud.PUBLIC_PAGES).toEqual(['/signup'])
    expect(cloud.REQUIRE_EMAIL_VERIFICATION).toBe(true)
    expect(await cloud.isActionAllowed('delete-account', user)).toBe(false)
    expect(cloud.SELF_AUTHENTICATED_API_ROUTES).toEqual(CLOUD_SELF_AUTHENTICATED_API_ROUTES)

    vi.resetModules()
    vi.stubEnv('KLEDG_CLOUD_MODE', '')
    const kledg = await import('@/lib/instance/policy')
    expect(kledg.PUBLIC_PAGES).toEqual([])
    expect(kledg.REQUIRE_EMAIL_VERIFICATION).toBe(false)
    expect(await kledg.companyCreationRefusal(user)).toEqual({ message: "La création de sociétés est réservée aux administrateurs de l'instance." })
    expect(await kledg.companyWriteRefusal('c1')).toBeNull()
    await expect(kledg.afterCompanyCreated('c1', user)).resolves.toBeUndefined()
  })
})

/**
 * The interface of Kledg Cloud through the instance slots
 * (components/instance/slots.tsx) in cloud mode: the banner, the sign-up
 * prompt of the login page, the settings pages; and the sign-up form.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const data = vi.hoisted(() => ({
  terms: [] as string[],
  account: null as null | Record<string, unknown>,
  member: false,
}))

vi.mock('@/lib/cloud/legal/terms-acceptance.service', () => ({ pendingTerms: vi.fn(async () => data.terms) }))
vi.mock('@/lib/cloud/billing/billing-account.service', async () => {
  const { billingAccess } = await import('@/lib/cloud/billing/state')
  return {
    findBillingAccount: vi.fn(async () => data.account),
    belongsToAnyCompany: vi.fn(async () => data.member),
    virtualBillingAccount: () => ({ subscriptionStatus: null, planId: null, deletionScheduledFor: null, deletionReason: null }),
    accessOf: (account: Parameters<typeof billingAccess>[0], now: Date) => billingAccess(account, now, { graceDays: 14, retrievalDays: 30 }),
  }
})
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

import { InstanceBanner, instanceSettingsPages, LoginExtra } from '@/components/instance/slots'
import { CloudBanner } from '../cloud-banner'
import { SignupForm } from '../signup-form'

const user = { id: 'u1', email: 'claire@test.local', role: 'user' }
const now = new Date('2026-11-10T09:00:00Z')

beforeEach(() => {
  vi.stubEnv('KLEDG_CLOUD_MODE', 'true')
  data.terms = []
  data.account = null
  data.member = false
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('cloud slots', () => {
  it('add the billing and data pages for customers, the console for the operator', async () => {
    expect((await instanceSettingsPages(user)).map((p) => [p.group, p.title, p.url])).toEqual([
      ['account', 'Facturation', '/settings/billing'],
      ['account', 'Données et compte', '/settings/data'],
    ])
    expect((await instanceSettingsPages({ ...user, role: 'admin' })).map((p) => p.url)).toEqual(['/settings/console'])
    vi.stubEnv('KLEDG_CLOUD_MODE', '')
    expect(await instanceSettingsPages(user)).toEqual([])
  })

  it('invite to sign up on the login page, only in cloud mode', () => {
    render(LoginExtra({ redirectTo: '/' }))
    expect(screen.getByRole('link', { name: 'Créer un compte, essai gratuit' })).toHaveAttribute('href', '/inscription')
    vi.stubEnv('KLEDG_CLOUD_MODE', '')
    expect(LoginExtra({ redirectTo: '/' })).toBeNull()
    expect(InstanceBanner({ user })).toBeNull()
  })
})

describe('cloud banner', () => {
  it('asks to accept new terms first', async () => {
    data.terms = ['cgv']
    render(await CloudBanner({ user, now }))
    expect(screen.getByRole('status')).toHaveTextContent('évoluent (version 1.0). Lisez-les et acceptez-les pour continuer à utiliser Kledg.')
    expect(screen.getByRole('link', { name: 'conditions générales de vente' })).toHaveAttribute('href', 'https://www.kledg.com/fr/terms')
    expect(screen.getByRole('button', { name: "J'accepte" })).toBeInTheDocument()
  })

  it('tells a new user how to start, then shows the trial', async () => {
    render(await CloudBanner({ user, now }))
    expect(screen.getByRole('status')).toHaveTextContent('Essai gratuit de 30 jours, sans carte bancaire : choisissez une offre pour créer votre première société.')
    expect(screen.getByRole('link', { name: 'Choisir une offre' })).toHaveAttribute('href', '/settings/billing')
  })

  it('shows the trial days left', async () => {
    data.account = {
      trialEnd: new Date('2026-11-20T09:00:00Z'),
      subscriptionStatus: 'trialing',
      planId: 'holding',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      subscriptionEndedAt: null,
      paymentFailedAt: null,
      deletionScheduledFor: null,
      deletionReason: null,
    }
    render(await CloudBanner({ user, now }))
    expect(screen.getByRole('status')).toHaveTextContent('Essai gratuit : il vous reste 10 jours.')
    expect(screen.getByRole('link', { name: 'Gérer mon abonnement' })).toHaveAttribute('href', '/settings/billing')
  })

  it('shows nothing to a member invited elsewhere, an active subscriber or the operator', async () => {
    data.member = true
    expect(await CloudBanner({ user, now })).toBeNull()
    data.account = { subscriptionStatus: 'active', planId: 'holding', cancelAtPeriodEnd: false, deletionScheduledFor: null, deletionReason: null }
    expect(await CloudBanner({ user, now })).toBeNull()
    data.terms = ['cgv']
    expect(await CloudBanner({ user: { ...user, role: 'admin' }, now })).toBeNull()
  })
})

describe('sign-up form', () => {
  it('requires the terms, sends the version read, then points to the mailbox', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const ui = userEvent.setup()
    render(<SignupForm termsVersion="cgv:1.0" cgvVersion="1.0" trialDays={30} />)
    expect(screen.getByText(/30 jours d'essai gratuit, sans carte bancaire/)).toBeInTheDocument()
    await ui.type(screen.getByLabelText('Email'), 'claire@societe.fr')
    await ui.type(screen.getByLabelText('Mot de passe'), 'un-mot-de-passe-solide')
    await ui.click(screen.getByRole('button', { name: 'Créer mon compte' }))
    expect(screen.getByText('Acceptez les conditions générales pour créer un compte.')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()

    await ui.click(screen.getByRole('checkbox'))
    await ui.click(screen.getByRole('button', { name: 'Créer mon compte' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Vérifiez votre boîte mail' })).toBeInTheDocument())
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      email: 'claire@societe.fr',
      name: '',
      password: 'un-mot-de-passe-solide',
      acceptTerms: true,
      termsVersion: 'cgv:1.0',
      website: '',
    })
  })

  it('shows the French error of the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Trop de demandes pour cette adresse. Réessayez dans une heure.' }), { status: 429 })))
    const ui = userEvent.setup()
    render(<SignupForm termsVersion="v" cgvVersion="1.0" trialDays={30} />)
    await ui.type(screen.getByLabelText('Email'), 'claire@societe.fr')
    await ui.type(screen.getByLabelText('Mot de passe'), 'un-mot-de-passe-solide')
    await ui.click(screen.getByRole('checkbox'))
    await ui.click(screen.getByRole('button', { name: 'Créer mon compte' }))
    expect(await screen.findByText('Trop de demandes pour cette adresse. Réessayez dans une heure.')).toBeInTheDocument()
  })
})

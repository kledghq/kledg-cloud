'use client'

import { useEffect, useState } from 'react'
import { ExternalLink, FileText } from 'lucide-react'
import { toast } from 'sonner'
import type { BillingOverview } from '@/lib/cloud/billing/billing-overview.service'
import type { InvoiceSummary } from '@/lib/cloud/billing/checkout.service'
import type { BillingInterval, PlanId } from '@/lib/cloud/billing/plans'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { DateDisplay, EmptyState, StatusBadge, formatAmount, type StatusTone } from '@/components/shared'

const PHASES: Record<BillingOverview['phase'], { label: string; tone: StatusTone }> = {
  none: { label: 'Aucune offre', tone: 'neutral' },
  trial: { label: 'Essai gratuit', tone: 'info' },
  active: { label: 'Actif', tone: 'success' },
  grace: { label: 'Paiement à régler', tone: 'warning' },
  read_only: { label: 'Lecture seule', tone: 'danger' },
}

const INVOICE_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  paid: { label: 'Payée', tone: 'success' },
  open: { label: 'À payer', tone: 'warning' },
  uncollectible: { label: 'Impayée', tone: 'danger' },
  void: { label: 'Annulée', tone: 'neutral' },
}

const PER: Record<BillingInterval, string> = { month: 'mois', year: 'an' }

function limitText(limit: number | null, included: number | null = null): string {
  if (limit === null) return included ? `${included} sociétés incluses` : 'sans limite'
  return limit === 1 ? '1 société' : `${limit} sociétés`
}

/** POSTs to a billing route that answers a Stripe-hosted URL, then goes there. */
async function openStripe(path: string, body?: unknown): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const data = (await response.json().catch(() => ({}))) as { url?: string; error?: string }
  if (!response.ok || !data.url) throw new Error(data.error ?? "Stripe n'a pas répondu. Réessayez dans quelques instants.")
  window.location.assign(data.url)
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

export function BillingSettings({ overview, checkout }: { overview: BillingOverview; checkout: 'success' | 'cancel' | null }) {
  const [interval, setInterval] = useState<BillingInterval>('month')
  const [pending, setPending] = useState<string | null>(null)
  const phase = PHASES[overview.phase]

  async function run(key: string, action: () => Promise<void>) {
    setPending(key)
    try {
      await action()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Une erreur est survenue. Réessayez.')
      setPending(null)
    }
  }

  const choose = (plan: PlanId) => run(plan, () => openStripe('/api/billing/checkout', { plan, interval }))
  const portal = () => run('portal', () => openStripe('/api/billing/portal'))
  const offered = overview.plans.filter((plan) => plan.prices[interval] !== undefined)
  const yearly = overview.plans.some((plan) => plan.prices.year !== undefined)

  return (
    <div className="space-y-6">
      {checkout === 'success' ? (
        <Alert>
          <AlertDescription>Merci&nbsp;! Votre offre est enregistrée&nbsp;: elle apparaît ici dans quelques instants.</AlertDescription>
        </Alert>
      ) : checkout === 'cancel' ? (
        <Alert>
          <AlertDescription>Rien n&apos;a été souscrit ni facturé.</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle>
              <h2>Votre offre</h2>
            </CardTitle>
            <CardDescription>
              {overview.planName
                ? `Offre ${overview.planName}${overview.billingInterval ? `, facturée par ${PER[overview.billingInterval]}` : ''}`
                : 'Aucune offre en cours'}
            </CardDescription>
          </div>
          <StatusBadge tone={phase.tone}>{phase.label}</StatusBadge>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Fact label="Sociétés">
              <span className="num">
                {overview.companyCount}
                {overview.planId ? ` sur ${limitText(overview.companyLimit, overview.planId === 'cabinet' ? 25 : null)}` : ''}
                {overview.extraCompanies > 0 ? `, dont ${overview.extraCompanies} en supplément` : ''}
              </span>
            </Fact>
            {overview.trialEndsAt ? (
              <Fact label="Fin de l'essai">
                <DateDisplay value={overview.trialEndsAt} format="long" />
              </Fact>
            ) : null}
            {overview.readOnlyAt && overview.phase === 'grace' ? (
              <Fact label="Lecture seule à partir du">
                <DateDisplay value={overview.readOnlyAt} format="long" />
              </Fact>
            ) : null}
            {overview.retrievalEndsAt ? (
              <Fact label="Données exportables jusqu'au">
                <DateDisplay value={overview.retrievalEndsAt} format="long" />
              </Fact>
            ) : null}
            {overview.deletionAt && overview.reason === 'deletion_requested' ? (
              <Fact label="Suppression du compte le">
                <DateDisplay value={overview.deletionAt} format="long" />
              </Fact>
            ) : null}
            {overview.endsAt ? (
              <Fact label="Fin de l'abonnement">
                <DateDisplay value={overview.endsAt} format="long" />
              </Fact>
            ) : null}
          </dl>
          {overview.phase === 'trial' ? (
            <p className="text-muted-foreground text-sm">
              L&apos;essai ne devient pas payant sans votre accord&nbsp;: ajoutez un moyen de paiement dans «&nbsp;Gérer mon abonnement&nbsp;» pour continuer après
              l&apos;essai. Sans cela, il prend fin à sa date.
            </p>
          ) : overview.phase === 'read_only' ? (
            <p className="text-muted-foreground text-sm">Vos sociétés restent consultables et exportables (FEC, export complet).</p>
          ) : null}
          {overview.hasCustomer ? (
            <Button variant="outline" size="sm" onClick={portal} loading={pending === 'portal'} disabled={pending !== null}>
              <ExternalLink aria-hidden />
              Gérer mon abonnement
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {overview.subscribed || overview.reason === 'deletion_requested' ? null : (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5">
              <CardTitle>
                <h2>Choisir une offre</h2>
              </CardTitle>
              <CardDescription>
                {overview.trialAvailable
                  ? `Essai gratuit de ${overview.trialDays} jours, sans carte bancaire. `
                  : ''}
                Prix hors taxes, TVA calculée au paiement. Les personnes que vous invitez dans vos sociétés ne paient pas.
              </CardDescription>
            </div>
            {yearly ? (
              <ToggleGroup
                type="single"
                size="sm"
                variant="outline"
                value={interval}
                onValueChange={(value) => value && setInterval(value as BillingInterval)}
                aria-label="Période de facturation"
              >
                <ToggleGroupItem value="month">Mensuel</ToggleGroupItem>
                <ToggleGroupItem value="year">Annuel</ToggleGroupItem>
              </ToggleGroup>
            ) : null}
          </CardHeader>
          <CardContent>
            {!overview.stripeConfigured || offered.length === 0 ? (
              <EmptyState title="Offres bientôt disponibles" description="Les abonnements ouvrent prochainement. Vos données ne sont pas concernées." />
            ) : (
              <ul className="grid gap-3 sm:grid-cols-3">
                {offered.map((plan) => (
                  <li key={plan.id} className="flex flex-col gap-3 rounded-lg border p-4">
                    <div className="space-y-1">
                      <h3 className="font-medium">{plan.name}</h3>
                      <p className="num text-lg font-semibold">
                        {formatAmount((plan.prices[interval] ?? 0) / 100)}{' '}
                        <span className="text-muted-foreground text-sm font-normal">HT / {PER[interval]}</span>
                      </p>
                      <p className="text-muted-foreground text-sm">{plan.description}</p>
                      <p className="text-sm">
                        {plan.companyLimit === null ? `${plan.includedCompanies} sociétés incluses` : `Jusqu'à ${limitText(plan.companyLimit)}`}
                        {plan.extraCompany[interval] !== undefined
                          ? `, puis ${formatAmount((plan.extraCompany[interval] ?? 0) / 100)} HT par société et par ${PER[interval]}`
                          : ''}
                      </p>
                    </div>
                    <Button size="sm" className="mt-auto" onClick={() => choose(plan.id)} loading={pending === plan.id} disabled={pending !== null}>
                      {overview.trialAvailable ? `Essayer ${plan.name}` : `Choisir ${plan.name}`}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <InvoicesCard enabled={overview.hasCustomer} />
    </div>
  )
}

function InvoicesCard({ enabled }: { enabled: boolean }) {
  const [state, setState] = useState<{ status: 'loading' | 'error' | 'ready'; invoices: InvoiceSummary[]; error?: string }>({
    status: enabled ? 'loading' : 'ready',
    invoices: [],
  })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetch('/api/billing/invoices')
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { invoices?: InvoiceSummary[]; error?: string }
        if (cancelled) return
        if (!response.ok) setState({ status: 'error', invoices: [], error: body.error })
        else setState({ status: 'ready', invoices: body.invoices ?? [] })
      })
      .catch(() => !cancelled && setState({ status: 'error', invoices: [] }))
    return () => {
      cancelled = true
    }
  }, [enabled, attempt])

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Factures</h2>
        </CardTitle>
      </CardHeader>
      <CardContent aria-busy={state.status === 'loading'}>
        {state.status === 'loading' ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : state.status === 'error' ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-destructive">{state.error ?? 'Les factures ne sont pas disponibles pour le moment.'}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setState({ status: 'loading', invoices: [] })
                setAttempt((n) => n + 1)
              }}
            >
              Réessayer
            </Button>
          </div>
        ) : state.invoices.length === 0 ? (
          <EmptyState icon={FileText} title="Aucune facture" description="Vos factures apparaîtront ici après votre premier paiement." />
        ) : (
          <ul className="divide-y text-sm">
            {state.invoices.map((invoice) => {
              const status = INVOICE_STATUS[invoice.status ?? ''] ?? { label: invoice.status ?? '', tone: 'neutral' as const }
              return (
                <li key={invoice.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span className="flex items-center gap-3">
                    <DateDisplay value={invoice.date} />
                    <span className="text-muted-foreground">{invoice.number}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="num">{formatAmount(invoice.totalCents / 100)}</span>
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                    {invoice.pdfUrl ? (
                      <a href={invoice.pdfUrl} target="_blank" rel="noreferrer" className="text-link underline-offset-4 hover:underline">
                        PDF
                      </a>
                    ) : null}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

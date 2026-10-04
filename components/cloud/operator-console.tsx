'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import type { OperatorAccount } from '@/lib/cloud/operator/operator.service'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DateDisplay, EmptyState, StatusBadge, type StatusTone } from '@/components/shared'

const PHASES: Record<OperatorAccount['phase'], { label: string; tone: StatusTone }> = {
  none: { label: 'Sans offre', tone: 'neutral' },
  trial: { label: 'Essai', tone: 'info' },
  active: { label: 'Actif', tone: 'success' },
  grace: { label: 'Paiement à régler', tone: 'warning' },
  read_only: { label: 'Lecture seule', tone: 'danger' },
}

/** Operator console: the accounts, read-only, and the extension of a running trial. */
export function OperatorConsole({ initial, nextCursor: initialCursor }: { initial: OperatorAccount[]; nextCursor: string | null }) {
  const [accounts, setAccounts] = useState(initial)
  const [nextCursor, setNextCursor] = useState(initialCursor)
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState<string | null>(null)

  async function load(cursor: string | null, query: string) {
    const params = new URLSearchParams()
    if (query) params.set('search', query)
    if (cursor) params.set('cursor', cursor)
    const response = await fetch(`/api/cloud/operator/accounts?${params}`)
    const body = (await response.json().catch(() => ({}))) as { accounts?: OperatorAccount[]; nextCursor?: string | null; error?: string }
    if (!response.ok) {
      toast.error(body.error ?? 'La liste des comptes ne se charge pas. Réessayez.')
      return
    }
    setAccounts((current) => (cursor ? [...current, ...(body.accounts ?? [])] : (body.accounts ?? [])))
    setNextCursor(body.nextCursor ?? null)
  }

  async function extend(account: OperatorAccount) {
    setPending(account.id)
    try {
      const response = await fetch(`/api/cloud/operator/accounts/${account.id}/trial`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 14 }),
      })
      const body = (await response.json().catch(() => ({}))) as { trialEnd?: string; error?: string }
      if (!response.ok || !body.trialEnd) {
        toast.error(body.error ?? "L'essai n'a pas pu être prolongé.")
        return
      }
      setAccounts((current) => current.map((a) => (a.id === account.id ? { ...a, trialEnd: body.trialEnd ?? a.trialEnd } : a)))
      toast.success('Essai prolongé de 14 jours')
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="space-y-4">
      <form
        className="flex max-w-md gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void load(null, search.trim())
        }}
      >
        <Input aria-label="Rechercher par adresse email" placeholder="ex. claire@societe.fr" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button type="submit" variant="outline">
          Rechercher
        </Button>
      </form>
      {accounts.length === 0 ? (
        <EmptyState bordered title="Aucun compte" description="Les comptes apparaissent ici dès qu'un client choisit une offre ou crée une société." />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Titulaire</TableHead>
                <TableHead>Offre</TableHead>
                <TableHead>État</TableHead>
                <TableHead>Fin de l&apos;essai</TableHead>
                <TableHead className="text-right">Sociétés</TableHead>
                <TableHead>Créé le</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((account) => (
                <TableRow key={account.id}>
                  <TableCell>{account.ownerEmail ?? 'Compte supprimé'}</TableCell>
                  <TableCell>
                    {account.planId ?? 'Aucune'}
                    {account.billingInterval ? ` (${account.billingInterval === 'year' ? 'annuel' : 'mensuel'})` : ''}
                    {account.dedicatedDatabase ? ', base dédiée' : ''}
                    {account.discount ? (
                      <span className="text-muted-foreground block text-xs">Remise {account.discount}</span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={PHASES[account.phase].tone}>{PHASES[account.phase].label}</StatusBadge>
                    {account.deletionScheduledFor ? (
                      <span className="text-muted-foreground block text-xs">
                        Suppression le <DateDisplay value={account.deletionScheduledFor} />
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <DateDisplay value={account.trialEnd} empty="Aucun" />
                  </TableCell>
                  <TableCell className="num text-right">
                    {account.companies}
                    {account.extraCompanies > 0 ? ` (+${account.extraCompanies} facturées)` : ''}
                  </TableCell>
                  <TableCell>
                    <DateDisplay value={account.createdAt} />
                  </TableCell>
                  <TableCell className="text-right">
                    {account.subscriptionStatus === 'trialing' ? (
                      <Button size="xs" variant="outline" onClick={() => extend(account)} loading={pending === account.id}>
                        Prolonger de 14 jours
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {nextCursor ? (
        <Button variant="outline" size="sm" onClick={() => load(nextCursor, search.trim())}>
          Charger plus
        </Button>
      ) : null}
    </div>
  )
}

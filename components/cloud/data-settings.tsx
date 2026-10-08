'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import type { DeletionPreview } from '@/lib/cloud/account/account-deletion.service'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ConfirmDialog, DateDisplay, EmptyState } from '@/components/shared'

interface ExportableCompany {
  id: string
  slug: string
  name: string
}

/** "Données et compte": full export of each company, and account deletion (scheduled, cancellable). */
export function DataSettings({ companies, deletion, email }: { companies: ExportableCompany[]; deletion: DeletionPreview; email: string }) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Exporter vos données</h2>
          </CardTitle>
          <CardDescription>
            Une archive par société&nbsp;: le FEC de chaque exercice, toutes les données au format JSON et vos justificatifs, avec un manifeste qui relie chacun à sa transaction ou à sa note de frais. Disponible à tout moment, même en lecture seule.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {companies.length === 0 ? (
            <EmptyState title="Aucune société à exporter" description="Vous pouvez exporter les sociétés dont vous êtes administrateur." />
          ) : (
            <ul className="divide-y text-sm">
              {companies.map((company) => (
                <li key={company.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span className="font-medium">{company.name}</span>
                  <Button asChild size="sm" variant="outline">
                    <a href={`/api/cloud/export?companyId=${encodeURIComponent(company.slug)}`} download>
                      <Download aria-hidden />
                      Télécharger l&apos;export complet
                    </a>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <DeletionCard deletion={deletion} email={email} />
    </div>
  )
}

function DeletionCard({ deletion: initial, email }: { deletion: DeletionPreview; email: string }) {
  const router = useRouter()
  const [deletion, setDeletion] = useState(initial)
  const [typedEmail, setTypedEmail] = useState('')
  const [password, setPassword] = useState('')
  const [acknowledge, setAcknowledge] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [loading, setLoading] = useState(false)
  const withBooks = deletion.companies.filter((c) => c.hasBooks)

  async function call(method: 'POST' | 'DELETE', body?: unknown) {
    setLoading(true)
    try {
      const response = await fetch('/api/cloud/account/deletion', {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const data = (await response.json().catch(() => ({}))) as DeletionPreview & { error?: string }
      if (!response.ok) {
        toast.error(data.error ?? 'La demande a échoué. Réessayez.')
        return
      }
      setDeletion(data)
      setPassword('')
      toast.success(method === 'POST' ? 'Suppression programmée' : 'Suppression annulée')
      router.refresh()
    } catch {
      toast.error('La demande a échoué. Vérifiez votre connexion et réessayez.')
    } finally {
      setLoading(false)
      setConfirming(false)
    }
  }

  if (deletion.scheduledFor) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Suppression du compte</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <Alert variant="destructive">
            <AlertDescription>
              <span>
                Votre compte et les données de vos sociétés seront supprimés le <DateDisplay value={deletion.scheduledFor} format="long" />. D&apos;ici là, le
                compte est en lecture seule et vos exports restent disponibles.
              </span>
            </AlertDescription>
          </Alert>
          {deletion.reason === 'requested' ? (
            <Button size="sm" variant="outline" onClick={() => call('DELETE')} loading={loading}>
              Annuler la suppression
            </Button>
          ) : (
            <p className="text-muted-foreground">Votre abonnement a pris fin&nbsp;: choisissez une offre depuis la page Facturation pour conserver votre compte.</p>
          )}
        </CardContent>
      </Card>
    )
  }

  const ready = typedEmail.trim().toLowerCase() === email.toLowerCase() && password.length > 0 && (withBooks.length === 0 || acknowledge)

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Supprimer votre compte</h2>
        </CardTitle>
        <CardDescription>
          La suppression a lieu {deletion.deletionDays} jours après votre demande. Pendant ce délai, votre compte est en lecture seule&nbsp;: vous pouvez annuler la
          suppression et exporter vos données.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {deletion.blockers.length > 0 ? (
          <Alert variant="destructive">
            <AlertDescription>{deletion.blockers.join(' ')}</AlertDescription>
          </Alert>
        ) : null}
        {deletion.companies.length > 0 ? (
          <div className="space-y-1">
            <p>Ces sociétés seront supprimées avec votre compte, pour tous leurs membres&nbsp;:</p>
            <ul className="text-muted-foreground list-disc pl-5">
              {deletion.companies.map((company) => (
                <li key={company.id}>
                  {company.name}
                  {company.hasBooks ? ', livres comptables compris' : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="delete-email">Adresse email du compte</Label>
            <Input id="delete-email" type="email" autoComplete="off" value={typedEmail} onChange={(e) => setTypedEmail(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="delete-password">Mot de passe</Label>
            <Input id="delete-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </div>
        {withBooks.length > 0 ? (
          <div className="flex items-start gap-2">
            <Checkbox id="delete-books" checked={acknowledge} onCheckedChange={(v) => setAcknowledge(v === true)} className="mt-0.5" />
            <Label htmlFor="delete-books" className="leading-snug font-normal">
              J&apos;ai exporté mes livres comptables. Je sais qu&apos;ils seront supprimés définitivement et que ma société doit les conserver 10 ans (Code de
              commerce art. L123-22).
            </Label>
          </div>
        ) : null}
        <Button size="sm" variant="outline" className="hover:text-destructive" disabled={!ready || deletion.blockers.length > 0} onClick={() => setConfirming(true)}>
          Supprimer mon compte
        </Button>
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={'Supprimer votre compte ?'}
          description={`Votre compte et les données de vos sociétés seront supprimés dans ${deletion.deletionDays} jours. Vous pourrez annuler d'ici là.`}
          confirmLabel="Supprimer mon compte"
          loading={loading}
          onConfirm={() => call('POST', { email: typedEmail, password, acknowledgeBooksDeletion: acknowledge })}
        />
      </CardContent>
    </Card>
  )
}

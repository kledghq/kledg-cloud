'use client'

import { useState } from 'react'
import Link from 'next/link'
import { MailCheck } from 'lucide-react'
import { AuthShell } from '@/components/brand/auth-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { LEGAL_URLS } from '@/lib/cloud/config'

/**
 * Sign-up form of Kledg Cloud (POST /api/signup). The answer is the same
 * whether the address has an account or not: the next step is always in the
 * mailbox. `termsVersion` is the version of the CGV shown here, so
 * an acceptance always names what was read.
 */
export function SignupForm({ termsVersion, cgvVersion, trialDays }: { termsVersion: string; cgvVersion: string; trialDays: number }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [acceptTerms, setAcceptTerms] = useState(false)
  const [website, setWebsite] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (!acceptTerms) {
      setError('Acceptez les conditions générales pour créer un compte.')
      return
    }
    setLoading(true)
    try {
      const response = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name, password, acceptTerms, termsVersion, website }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? "Le compte n'a pas pu être créé. Réessayez.")
        return
      }
      setSent(true)
    } catch {
      setError("Le compte n'a pas pu être créé. Vérifiez votre connexion et réessayez.")
    } finally {
      setLoading(false)
    }
  }

  if (sent) {
    return (
      <AuthShell>
        <Card>
          <CardHeader>
            <CardTitle>
              <h1 className="flex items-center gap-2">
                <MailCheck aria-hidden className="size-4" />
                Vérifiez votre boîte mail
              </h1>
            </CardTitle>
            <CardDescription>
              Nous avons envoyé un message à <strong className="text-foreground">{email}</strong>. Suivez le lien qu&apos;il contient pour confirmer votre adresse, puis connectez-vous.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-2 text-sm">
            <p>Le lien est valable une heure. Pensez à regarder dans les courriers indésirables.</p>
            <p>Pas de message&nbsp;? Connectez-vous avec votre adresse et votre mot de passe&nbsp;: un nouveau lien vous sera envoyé.</p>
          </CardContent>
          <CardFooter>
            <Button asChild variant="outline" className="w-full">
              <Link href="/login">Aller à la connexion</Link>
            </Button>
          </CardFooter>
        </Card>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1>Créer un compte</h1>
          </CardTitle>
          <CardDescription>
            {trialDays} jours d&apos;essai gratuit, sans carte bancaire, en choisissant votre offre. Vous créez ensuite votre première société.
          </CardDescription>
        </CardHeader>
        <form onSubmit={submit} noValidate>
          <CardContent className="space-y-4">
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="signup-email">Email</Label>
              <Input
                id="signup-email"
                type="email"
                autoComplete="email"
                placeholder="vous@societe.fr"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={loading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-name">Nom</Label>
              <Input
                id="signup-name"
                autoComplete="name"
                placeholder="ex. Claire Martin"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={loading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-password">Mot de passe</Label>
              <Input
                id="signup-password"
                type="password"
                autoComplete="new-password"
                minLength={10}
                aria-describedby="signup-password-hint"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={loading}
              />
              <p id="signup-password-hint" className="text-muted-foreground text-xs">
                Au moins 10 caractères.
              </p>
            </div>
            {/* Honeypot: hidden from people and assistive technologies, filled by bots. */}
            <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
              <label htmlFor="signup-website">Site web</label>
              <input id="signup-website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id="signup-terms"
                checked={acceptTerms}
                onCheckedChange={(value) => setAcceptTerms(value === true)}
                disabled={loading}
                className="mt-0.5"
              />
              <Label htmlFor="signup-terms" className="text-sm leading-snug font-normal">
                <span>
                  J&apos;accepte les{' '}
                  <a href={LEGAL_URLS.cgv} target="_blank" rel="noreferrer" className="text-link underline-offset-4 hover:underline">
                    conditions générales de vente
                  </a>{' '}
                  (version {cgvVersion}) et j&apos;ai lu la{' '}
                  <a href={LEGAL_URLS.privacy} target="_blank" rel="noreferrer" className="text-link underline-offset-4 hover:underline">
                    politique de confidentialité
                  </a>
                  .
                </span>
              </Label>
            </div>
          </CardContent>
          <CardFooter className="flex flex-col gap-4 pt-6">
            <Button type="submit" className="w-full" loading={loading}>
              Créer mon compte
            </Button>
            <p className="text-muted-foreground text-sm">
              Déjà un compte&nbsp;?{' '}
              <Link href="/login" className="text-link underline-offset-4 hover:underline">
                Se connecter
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </AuthShell>
  )
}

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { CircleCheck } from 'lucide-react'
import { isCloudMode } from '@/lib/cloud/config'
import { AuthShell } from '@/components/brand/auth-shell'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Adresse confirmée' }

/**
 * Where the confirmation link of a new account leads (Better Auth checks the
 * token, then redirects here). Shows no data: anyone may open it.
 */
export default function SignupVerifiedPage() {
  if (!isCloudMode()) notFound()
  return (
    <AuthShell>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="flex items-center gap-2">
              <CircleCheck aria-hidden className="text-success size-4" />
              Adresse confirmée
            </h1>
          </CardTitle>
          <CardDescription>
            Votre compte est prêt. Connectez-vous, choisissez une offre pour démarrer votre essai gratuit de 30 jours, puis créez votre première société.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild className="w-full">
            <Link href="/login">Se connecter</Link>
          </Button>
        </CardFooter>
      </Card>
    </AuthShell>
  )
}

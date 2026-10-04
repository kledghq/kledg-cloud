import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'

/** Above the sign-in card of Kledg Cloud (LoginExtra slot): the way to the sign-up page. */
export function SignupPrompt() {
  return (
    <Card className="py-4">
      <CardContent className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">Pas encore de compte&nbsp;?</span>
        <Link href="/signup" className="text-link font-medium underline-offset-4 hover:underline">
          Créer un compte, essai gratuit
        </Link>
      </CardContent>
    </Card>
  )
}

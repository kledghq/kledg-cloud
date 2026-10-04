'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

/** Accepts the current CGU and CGV from the banner (POST /api/cloud/terms). */
export function AcceptTermsButton({ version }: { version: string }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function accept() {
    setLoading(true)
    try {
      const response = await fetch('/api/cloud/terms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        toast.error(body.error ?? "L'acceptation n'a pas pu être enregistrée. Réessayez.")
        return
      }
      toast.success('Conditions acceptées')
      router.refresh()
    } catch {
      toast.error("L'acceptation n'a pas pu être enregistrée. Vérifiez votre connexion et réessayez.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button size="xs" onClick={accept} loading={loading}>
      J&apos;accepte
    </Button>
  )
}

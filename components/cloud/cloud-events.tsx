'use client'

import { useEffect } from 'react'
import { track } from '@vercel/analytics'

/**
 * Custom events of app.kledg.com (Vercel Web Analytics), rendered next to
 * <Analytics /> by CloudAnalytics, so only in cloud mode.
 *
 *   signup           {step}            submitted (POST /api/signup ok) | confirmed (/inscription/confirmee)
 *   company_created  {via}             POST /api/companies ok; siren_lookup if a SIREN lookup succeeded before, else manual
 *   bank_connect     {provider, result} ponto|revolut|statement_import, started|success
 *   file_selected    {ext, via}        receipt staged (POST /api/receipts/staged ok), via upload
 *   export           {report, format}  fec|balance_sheet|income_statement, txt|pdf|xlsx
 *
 * The events are read from the responses of the application's own API
 * calls, so the Kledg components merged from upstream stay untouched. Props
 * are fixed values only: never a company name, slug, id, amount, SIREN or
 * anything the user typed. Analytics must never break the application: the
 * original fetch result is always returned as is.
 */

type Props = Record<string, string>
export type CloudEvent = { name: string; props: Props }

const RECEIPT_EXTS = new Set(['pdf', 'jpg', 'png', 'heic'])

/** The extension of an uploaded receipt, as one of a few fixed values. */
export function receiptExt(fileName: string | undefined): string {
  const ext = fileName?.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
  if (ext === 'jpeg') return 'jpg'
  return RECEIPT_EXTS.has(ext) ? ext : 'other'
}

/**
 * The event a successful API call stands for, or null. `path` is the
 * pathname of the request (same origin), `query` its search params.
 * `sirenLookup` is true once a SIREN lookup succeeded on this page.
 * Exported for the tests.
 */
export function eventForResponse(
  method: string,
  path: string,
  query: URLSearchParams,
  sirenLookup: boolean,
  fileName?: string,
): CloudEvent | null {
  const m = method.toUpperCase()
  if (m === 'POST') {
    if (path === '/api/signup') return { name: 'signup', props: { step: 'submitted' } }
    if (path === '/api/companies') return { name: 'company_created', props: { via: sirenLookup ? 'siren_lookup' : 'manual' } }
    if (path === '/api/banking/ponto') return { name: 'bank_connect', props: { provider: 'ponto', result: 'success' } }
    if (path === '/api/banking/revolut/authorize') return { name: 'bank_connect', props: { provider: 'revolut', result: 'started' } }
    if (path === '/api/banking/import-statement') return { name: 'bank_connect', props: { provider: 'statement_import', result: 'success' } }
    if (path === '/api/receipts/staged') return { name: 'file_selected', props: { ext: receiptExt(fileName), via: 'upload' } }
    return null
  }
  if (m !== 'GET') return null
  if (path === '/api/fec' && !query.has('report')) return { name: 'export', props: { report: 'fec', format: 'txt' } }
  const report = /^\/api\/companies\/[^/]+\/(balance-sheet|income-statement)\/export-(pdf|excel)$/.exec(path)
  if (report) {
    return {
      name: 'export',
      props: { report: report[1] === 'balance-sheet' ? 'balance_sheet' : 'income_statement', format: report[2] === 'pdf' ? 'pdf' : 'xlsx' },
    }
  }
  return null
}

function send(event: CloudEvent) {
  try {
    track(event.name, event.props)
  } catch {
    /* analytics must never break the application */
  }
}

export function CloudEvents() {
  useEffect(() => {
    if (location.pathname === '/inscription/confirmee') send({ name: 'signup', props: { step: 'confirmed' } })

    let sirenLookup = false
    const original = window.fetch
    const observed: typeof window.fetch = (input, init) => {
      const result = original(input, init)
      try {
        const request = input instanceof Request ? input : null
        const url = new URL(request ? request.url : String(input), location.href)
        const method = init?.method ?? request?.method ?? 'GET'
        const body = init?.body
        const file = body instanceof FormData ? body.get('file') : null
        const fileName = file instanceof File ? file.name : undefined
        if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
          result
            .then((response) => {
              if (!response.ok) return
              if (url.pathname === '/api/companies/lookup') {
                sirenLookup = true
                return
              }
              const event = eventForResponse(method, url.pathname, url.searchParams, sirenLookup, fileName)
              if (event) send(event)
            })
            .catch(() => {})
        }
      } catch {
        /* never let analytics change the request */
      }
      return result
    }
    window.fetch = observed
    return () => {
      if (window.fetch === observed) window.fetch = original
    }
  }, [])
  return null
}

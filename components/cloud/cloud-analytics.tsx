'use client'

import { Analytics, type BeforeSendEvent } from '@vercel/analytics/next'

/**
 * First path segments that are application pages, not a company: every
 * other first segment is a company slug, made from the customer's company
 * name (app/(company)/[companyId]).
 */
const APP_SEGMENTS = new Set([
  '',
  'companies',
  'settings',
  'welcome',
  'login',
  'inscription',
  'consent',
  'forgot-password',
  'reset-password',
  'setup',
  'auth',
  'offline',
])

/** A database id (cuid) or a long hexadecimal or numeric id in a path segment. */
const ID_SEGMENT = /^(c[a-z0-9]{20,}|[0-9a-f-]{16,}|\d{4,})$/

/**
 * Page path without customer data: a company slug becomes [societe], record
 * ids become [id], and the query string (tokens, filters, searches) is
 * dropped. Exported for the tests.
 */
export function anonymizeAppUrl(url: string): string {
  const parsed = new URL(url)
  const segments = parsed.pathname.split('/').slice(1)
  const anonymized = segments.map((segment, index) => {
    if (index === 0 && !APP_SEGMENTS.has(segment)) return '[societe]'
    return ID_SEGMENT.test(segment) ? '[id]' : segment
  })
  return `${parsed.origin}/${anonymized.join('/')}`
}

/**
 * Vercel Web Analytics on app.kledg.com: cookieless page views, anonymized
 * paths. The referrer the script reports cannot be rewritten here: every
 * response carries Referrer-Policy: strict-origin (lib/security-headers.ts),
 * so it is the origin only, never a company page (KLEDG-R3-CLOUD-03).
 */
export function CloudAnalytics() {
  return <Analytics beforeSend={(event: BeforeSendEvent) => ({ ...event, url: anonymizeAppUrl(event.url) })} />
}

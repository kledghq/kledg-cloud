import { NextResponse } from 'next/server'
import { companyRoute, fromQuery } from '@/lib/api/route'
import { contentDisposition } from '@/lib/api/files'
import { enforceRateLimit } from '@/lib/rate-limit'
import { assertCloudMode } from '@/lib/cloud/http'
import { companyExportArchive } from '@/lib/cloud/export/export-company-data.service'

/** The archive streams within one function run: receipts included, a large company needs the time (docs/cloud.md#data-export). */
export const maxDuration = 300

/**
 * Full export of a company (?companyId=): its FEC per fiscal year, every
 * record as JSON and its receipt files with their manifest, in a streamed
 * ZIP (lib/cloud/export). Company
 * administrators only (the data controller's copy); always available,
 * read-only accounts included.
 */
export const GET = companyRoute({ company: fromQuery(), permission: { reports: ['export'] } }, async ({ companyId, user, authorize }) => {
  assertCloudMode()
  authorize({ settings: ['update'] })
  await enforceRateLimit('cloud-export', user.id)
  const { fileName, stream } = await companyExportArchive(companyId, user.id)
  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(fileName, 'attachment'),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  })
})

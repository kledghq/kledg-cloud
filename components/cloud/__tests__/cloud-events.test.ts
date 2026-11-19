import { describe, expect, it } from 'vitest'
import { eventForResponse, receiptExt } from '../cloud-events'

const q = (s = '') => new URLSearchParams(s)

describe('app.kledg.com custom events', () => {
  it('maps successful API calls to fixed events', () => {
    expect(eventForResponse('POST', '/api/signup', q(), false)).toEqual({ name: 'signup', props: { step: 'submitted' } })
    expect(eventForResponse('POST', '/api/companies', q(), true)).toEqual({ name: 'company_created', props: { via: 'siren_lookup' } })
    expect(eventForResponse('POST', '/api/companies', q(), false)?.props).toEqual({ via: 'manual' })
    expect(eventForResponse('POST', '/api/banking/ponto', q(), false)?.props).toEqual({ provider: 'ponto', result: 'success' })
    expect(eventForResponse('POST', '/api/banking/revolut/authorize', q(), false)?.props).toEqual({ provider: 'revolut', result: 'started' })
    expect(eventForResponse('POST', '/api/receipts/staged', q(), false, 'facture.JPEG')).toEqual({ name: 'file_selected', props: { ext: 'jpg', via: 'upload' } })
    expect(eventForResponse('GET', '/api/fec', q('companyId=c1&fiscalYearId=f1'), false)?.props).toEqual({ report: 'fec', format: 'txt' })
    expect(eventForResponse('GET', '/api/companies/cmutyyuef00lvczzlmw4on5qj/balance-sheet/export-excel', q(), false)?.props).toEqual({
      report: 'balance_sheet',
      format: 'xlsx',
    })
    expect(eventForResponse('GET', '/api/companies/c1/income-statement/export-pdf', q(), false)?.props).toEqual({ report: 'income_statement', format: 'pdf' })
  })

  it('ignores other calls and the FEC check request', () => {
    expect(eventForResponse('GET', '/api/fec', q('report=1'), false)).toBeNull()
    expect(eventForResponse('GET', '/api/receipts/staged', q(), false)).toBeNull()
    expect(eventForResponse('DELETE', '/api/receipts/staged/abc', q(), false)).toBeNull()
    expect(eventForResponse('POST', '/api/entries', q(), false)).toBeNull()
  })

  it('never sends a file name, only a fixed extension', () => {
    expect(receiptExt('Note de frais Dupont.pdf')).toBe('pdf')
    expect(receiptExt('scan.tiff')).toBe('other')
    expect(receiptExt(undefined)).toBe('other')
  })
})

/**
 * ZIP writer of the data export (lib/cloud/export/zip.ts): the standard
 * CRC-32, archives that read back entry by entry, UTF-8 names, and no path
 * that could escape the extraction folder.
 */

import { describe, expect, it } from 'vitest'
import { crc32, zipReadableStream, zipStream } from '../zip'
import { unzip, unzipEntries } from '../../__tests__/helpers/unzip'

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const chunk of chunks) parts.push(chunk)
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

describe('zip writer', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array())).toBe(0)
  })

  it('writes archives that read back, with UTF-8 names and a valid central directory', async () => {
    const big = 'JournalCode|JournalLib\n'.repeat(5000)
    const archive = await collect(
      zipStream(
        (async function* () {
          yield { name: 'LISEZMOI.txt', data: 'Export complet' }
          yield { name: 'fec/912345675FEC20261231.txt', data: big }
          yield { name: 'données/société.json', data: '{"nom":"Atelier Lumen"}' }
        })(),
        new Date('2026-10-20T10:00:00Z'),
      ),
    )
    // Starts with a local header, ends with the end of central directory record.
    expect([...archive.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(unzip(archive)).toEqual({
      'LISEZMOI.txt': 'Export complet',
      'fec/912345675FEC20261231.txt': big,
      'données/société.json': '{"nom":"Atelier Lumen"}',
    })
    // Deflate actually compresses the repetitive FEC.
    expect(archive.length).toBeLessThan(big.length / 10)
  })

  it('stores entries marked store as they are (photos, PDFs), next to deflated ones', async () => {
    const photo = new Uint8Array(4096).map((_, i) => (i * 7919) % 251)
    const archive = await collect(zipStream([{ name: 'justificatifs/ticket.jpg', data: photo, store: true }, { name: 'a.txt', data: 'a'.repeat(1000) }]))
    const entries = unzipEntries(archive)
    expect(entries['justificatifs/ticket.jpg'].method).toBe(0)
    expect([...entries['justificatifs/ticket.jpg'].bytes]).toEqual([...photo])
    expect(entries['a.txt'].method).toBe(8)
    // Local header: version needed 1.0 and method 0 for the stored entry.
    const view = new DataView(archive.buffer, archive.byteOffset)
    expect([view.getUint16(4, true), view.getUint16(8, true)]).toEqual([10, 0])
  })

  it('never writes a path that leaves the archive folder', async () => {
    const archive = await collect(zipStream([{ name: '../../etc/passwd', data: 'x' }, { name: '/abs\\win\\path.txt', data: 'y' }]))
    expect(Object.keys(unzip(archive))).toEqual(['etc/passwd', 'abs/win/path.txt'])
  })

  it('streams as a ReadableStream', async () => {
    const stream = zipReadableStream([{ name: 'a.txt', data: 'a' }])
    const reader = stream.getReader()
    const parts: Uint8Array[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(value)
    }
    const archive = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let offset = 0
    for (const part of parts) {
      archive.set(part, offset)
      offset += part.length
    }
    expect(unzip(archive)).toEqual({ 'a.txt': 'a' })
  })
})

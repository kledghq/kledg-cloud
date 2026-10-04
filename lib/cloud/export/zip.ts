/**
 * Minimal ZIP writer (PKWARE APPNOTE 6.3.x: local headers, deflate, central
 * directory), for the full data export. Entries are produced one after the
 * other, so the archive streams: only one entry is in memory at a time,
 * which keeps large books under the serverless memory and response limits.
 *
 * No dependency: Node's zlib deflates, CRC-32 is computed here. File names
 * are UTF-8 (general purpose bit 11). No ZIP64: an entry or the archive
 * above 4 GiB is refused, far beyond the books of a small company.
 */

import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string
  data: Uint8Array | string
}

const LIMIT = 0xffffffff

/** MS-DOS time and date of `date` (UTC, two-second resolution). */
function dosDateTime(date: Date): { time: number; day: number } {
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    day: ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  }
}

function safeName(name: string): string {
  // No absolute paths, no parent directories, no backslashes: an archive never writes outside its folder.
  const clean = name.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.' && part !== '..').join('/')
  if (!clean) throw new Error('Empty ZIP entry name')
  return clean
}

/**
 * The archive as a sequence of chunks, entry by entry: `entries` may be an
 * async generator that builds each file only when it is reached.
 */
export async function* zipStream(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>, now: Date = new Date()): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder()
  const { time, day } = dosDateTime(now)
  const central: Uint8Array[] = []
  let offset = 0
  let count = 0

  for await (const entry of entries) {
    const name = encoder.encode(safeName(entry.name))
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data
    const compressed = new Uint8Array(deflateRawSync(raw))
    if (raw.length >= LIMIT || compressed.length >= LIMIT || offset >= LIMIT) throw new Error('ZIP entry too large (no ZIP64)')
    const crc = crc32(raw)

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true) // version needed: 2.0 (deflate)
    local.setUint16(6, 0x0800, true) // UTF-8 names
    local.setUint16(8, 8, true) // deflate
    local.setUint16(10, time, true)
    local.setUint16(12, day, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, compressed.length, true)
    local.setUint32(22, raw.length, true)
    local.setUint16(26, name.length, true)
    local.setUint16(28, 0, true)

    const header = new DataView(new ArrayBuffer(46))
    header.setUint32(0, 0x02014b50, true)
    header.setUint16(4, 20, true)
    header.setUint16(6, 20, true)
    header.setUint16(8, 0x0800, true)
    header.setUint16(10, 8, true)
    header.setUint16(12, time, true)
    header.setUint16(14, day, true)
    header.setUint32(16, crc, true)
    header.setUint32(20, compressed.length, true)
    header.setUint32(24, raw.length, true)
    header.setUint16(28, name.length, true)
    header.setUint32(42, offset, true)
    central.push(new Uint8Array(header.buffer), name)

    yield new Uint8Array(local.buffer)
    yield name
    yield compressed
    offset += 30 + name.length + compressed.length
    count += 1
  }

  const directorySize = central.reduce((sum, part) => sum + part.length, 0)
  for (const part of central) yield part
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, count, true)
  end.setUint16(10, count, true)
  end.setUint32(12, directorySize, true)
  end.setUint32(16, offset, true)
  yield new Uint8Array(end.buffer)
}

/** A ReadableStream over `zipStream`, for a streamed HTTP response. */
export function zipReadableStream(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>, now?: Date): ReadableStream<Uint8Array> {
  const chunks = zipStream(entries, now)
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next()
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel() {
      await chunks.return(undefined)
    },
  })
}

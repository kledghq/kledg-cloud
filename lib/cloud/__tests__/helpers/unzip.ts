/** Reads a ZIP archive (central directory, deflate or stored) into { name: text }, to check exports in tests. */

import { inflateRawSync } from 'node:zlib'

/** Every entry of the archive as bytes, with its compression method (0 stored, 8 deflate). */
export function unzipEntries(archive: Uint8Array): Record<string, { bytes: Uint8Array; method: number }> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  let end = archive.length - 22
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1
  if (end < 0) throw new Error('No end of central directory')
  const count = view.getUint16(end + 10, true)
  let offset = view.getUint32(end + 16, true)
  const files: Record<string, { bytes: Uint8Array; method: number }> = {}
  const decoder = new TextDecoder()
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('Bad central directory header')
    const method = view.getUint16(offset + 10, true)
    const size = view.getUint32(offset + 20, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extra = view.getUint16(offset + 30, true)
    const comment = view.getUint16(offset + 32, true)
    const local = view.getUint32(offset + 42, true)
    const name = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength))
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const data = archive.subarray(dataStart, dataStart + size)
    files[name] = { bytes: method === 8 ? new Uint8Array(inflateRawSync(data)) : data, method }
    offset += 46 + nameLength + extra + comment
  }
  return files
}

export function unzip(archive: Uint8Array): Record<string, string> {
  const decoder = new TextDecoder()
  return Object.fromEntries(Object.entries(unzipEntries(archive)).map(([name, entry]) => [name, decoder.decode(entry.bytes)]))
}

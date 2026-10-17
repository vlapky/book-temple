// Минимальное чтение ZIP (для EPUB и .fb2.zip): stored и deflate через DecompressionStream.

export type ZipEntry = () => Promise<Uint8Array>

export async function readZip(buf: Uint8Array): Promise<Map<string, ZipEntry>> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('Файл не является ZIP-архивом')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const utf8 = new TextDecoder()
  const files = new Map<string, ZipEntry>()
  for (let n = 0; n < count && dv.getUint32(p, true) === 0x02014b50; n++) {
    const method = dv.getUint16(p + 10, true)
    const csize = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const local = dv.getUint32(p + 42, true)
    const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    files.set(name, async () => {
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true)
      const data = buf.subarray(start, start + csize)
      if (method === 0) return data
      if (method !== 8) throw new Error(`Неподдерживаемое сжатие в архиве (${method})`)
      const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      return new Uint8Array(await new Response(stream).arrayBuffer())
    })
  }
  return files
}

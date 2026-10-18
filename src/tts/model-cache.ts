// Диагностика кэша голосовой модели (vosk-tts-web хранит файлы в IndexedDB «vosk-tts-web»).

const MODEL_FILES = 6

export interface ModelCacheInfo {
  files: number
  expected: number
  bytes: number
  /** Сколько ещё можно сохранить на устройстве для этого сайта (если браузер сообщает). */
  free: number | null
  persisted: boolean | null
}

async function cachedFiles(): Promise<{ files: number; bytes: number }> {
  // Не создаём базу, если её ещё нет.
  const list = await indexedDB.databases?.().catch(() => null)
  if (list && !list.some((d) => d.name === 'vosk-tts-web')) return { files: 0, bytes: 0 }
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open('vosk-tts-web')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  try {
    if (!db.objectStoreNames.contains('files')) return { files: 0, bytes: 0 }
    const blobs = await new Promise<Blob[]>((res, rej) => {
      const q = db.transaction('files').objectStore('files').getAll()
      q.onsuccess = () => res(q.result as Blob[])
      q.onerror = () => rej(q.error)
    })
    return { files: blobs.length, bytes: blobs.reduce((a, b) => a + (b?.size ?? 0), 0) }
  } finally {
    db.close()
  }
}

export async function modelCacheInfo(): Promise<ModelCacheInfo> {
  const { files, bytes } = await cachedFiles().catch(() => ({ files: 0, bytes: 0 }))
  let free: number | null = null
  let persisted: boolean | null = null
  try {
    const est = await navigator.storage?.estimate?.()
    if (est?.quota != null) free = Math.max(0, est.quota - (est.usage ?? 0))
    persisted = (await navigator.storage?.persisted?.()) ?? null
  } catch { /* браузер не сообщает */ }
  return { files, expected: MODEL_FILES, bytes, free, persisted }
}

export const formatMB = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1).replace('.', ',')} ГБ` : `${Math.round(b / 1e6)} МБ`)

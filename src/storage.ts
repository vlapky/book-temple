import type { Book, BookMeta } from './book/types'

const DB_NAME = 'comfort-reader'
let dbp: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 2)
    r.onupgradeneeded = () => {
      const d = r.result
      for (const name of ['books', 'library']) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id' })
      // v2: озвучка целых глав — звук по предложениям и статус главы.
      if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio')
      if (!d.objectStoreNames.contains('audioMeta')) d.createObjectStore('audioMeta')
    }
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  }))
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return db().then((d) => new Promise<T>((res, rej) => {
    const t = d.transaction(store, mode)
    const req = fn(t.objectStore(store))
    t.oncomplete = () => res(req ? req.result : (undefined as T))
    t.onerror = () => rej(t.error)
    t.onabort = () => rej(t.error)
  }))
}

export async function saveBook(book: Book): Promise<void> {
  const words = book.chapters.reduce((a, c) => a + c.words, 0)
  const prev = await tx<BookMeta | undefined>('library', 'readonly', (s) => s.get(book.id))
  await tx('books', 'readwrite', (s) => { s.put(book) })
  await tx('library', 'readwrite', (s) => {
    s.put({ id: book.id, title: book.title, author: book.author, words, addedAt: prev?.addedAt ?? book.addedAt, openedAt: Date.now() } satisfies BookMeta)
  })
}

export const loadBook = (id: string) => tx<Book | undefined>('books', 'readonly', (s) => s.get(id))
export const listBooks = () => tx<BookMeta[]>('library', 'readonly', (s) => s.getAll()).then((l) => l.sort((a, b) => b.openedAt - a.openedAt))

export async function touchBook(id: string): Promise<void> {
  const m = await tx<BookMeta | undefined>('library', 'readonly', (s) => s.get(id))
  if (m) await tx('library', 'readwrite', (s) => { s.put({ ...m, openedAt: Date.now() }) })
}

export async function deleteBook(id: string): Promise<void> {
  await tx('books', 'readwrite', (s) => { s.delete(id) })
  await tx('library', 'readwrite', (s) => { s.delete(id) })
  local.del(`pos:${id}`)
  local.del(`ann:${id}`)
  local.del(`dict:${id}`)
  // Озвучка глав этой книги больше не нужна.
  for (const store of ['audio', 'audioMeta']) await tx(store, 'readwrite', (st) => { st.delete(IDBKeyRange.bound(`${id}|`, `${id}|\uffff`)) }).catch(() => {})
}

/** localStorage с префиксом и защитой от недоступности (приватный режим и т.п.). */
export const local = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem('cr:' + key)
      return v == null ? fallback : (JSON.parse(v) as T)
    } catch { return fallback }
  },
  set(key: string, value: unknown): void {
    try { localStorage.setItem('cr:' + key, JSON.stringify(value)) } catch { /* квота или запрет */ }
  },
  del(key: string): void {
    try { localStorage.removeItem('cr:' + key) } catch { /* ignore */ }
  },
}

// ---------- Озвучка целых глав ----------

/** Готовый звук одного предложения. */
export interface SentenceAudio { wav: Blob; w0: number; starts: number[]; dur: number }
/** Статус главы: для каких настроек голоса озвучена, с какого предложения продолжать. */
export interface ChapterAudioMeta { gen: string; next: number; done: boolean }

const pad = (n: number, w: number) => String(n).padStart(w, '0')
const chapterPrefix = (book: string, ch: number) => `${book}|${pad(ch, 5)}|`
const range = (prefix: string) => IDBKeyRange.bound(prefix, prefix + '\uffff')

export const audioDb = {
  put: (book: string, ch: number, s: number, a: SentenceAudio) =>
    tx('audio', 'readwrite', (st) => { st.put(a, chapterPrefix(book, ch) + pad(s, 6)) }),
  get: (book: string, ch: number, s: number) =>
    tx<SentenceAudio | undefined>('audio', 'readonly', (st) => st.get(chapterPrefix(book, ch) + pad(s, 6))),
  getMeta: (book: string, ch: number) =>
    tx<ChapterAudioMeta | undefined>('audioMeta', 'readonly', (st) => st.get(chapterPrefix(book, ch))),
  putMeta: (book: string, ch: number, m: ChapterAudioMeta) =>
    tx('audioMeta', 'readwrite', (st) => { st.put(m, chapterPrefix(book, ch)) }),
  /** Номера глав книги, для которых что-то сохранено. */
  async chapters(book: string): Promise<number[]> {
    const keys = await tx<IDBValidKey[]>('audioMeta', 'readonly', (st) => st.getAllKeys(range(`${book}|`)))
    return keys.map((k) => +String(k).split('|')[1])
  },
  async deleteChapter(book: string, ch: number): Promise<void> {
    await tx('audio', 'readwrite', (st) => { st.delete(range(chapterPrefix(book, ch))) })
    await tx('audioMeta', 'readwrite', (st) => { st.delete(chapterPrefix(book, ch)) })
  },
  /** Удалить озвучку всех книг, кроме указанной. */
  async deleteOtherBooks(book: string): Promise<void> {
    for (const store of ['audio', 'audioMeta']) {
      await tx(store, 'readwrite', (st) => {
        st.delete(IDBKeyRange.upperBound(`${book}|`, true))
        st.delete(IDBKeyRange.lowerBound(`${book}|\uffff`, true))
      })
    }
  },
  async clear(): Promise<void> {
    await tx('audio', 'readwrite', (st) => { st.clear() })
    await tx('audioMeta', 'readwrite', (st) => { st.clear() })
  },
}

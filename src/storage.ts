import type { Book, BookMeta } from './book/types'

const DB_NAME = 'comfort-reader'
let dbp: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1)
    r.onupgradeneeded = () => {
      r.result.createObjectStore('books', { keyPath: 'id' })
      r.result.createObjectStore('library', { keyPath: 'id' })
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

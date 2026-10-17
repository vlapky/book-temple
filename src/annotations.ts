import { local } from './storage'

export type HlColor = 'yellow' | 'green' | 'blue' | 'pink'
export const HL_COLORS: { id: HlColor; name: string }[] = [
  { id: 'yellow', name: 'Жёлтый' },
  { id: 'green', name: 'Зелёный' },
  { id: 'blue', name: 'Голубой' },
  { id: 'pink', name: 'Розовый' },
]

export interface Bookmark { id: string; ch: number; s: number; created: number; label: string; snippet: string }
export interface Highlight { id: string; ch: number; w0: number; w1: number; color: HlColor; note: string; created: number; text: string }

interface Data { bookmarks: Bookmark[]; highlights: Highlight[] }

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7)

class Annotations {
  private bookId = ''
  private d: Data = { bookmarks: [], highlights: [] }
  private listeners: (() => void)[] = []

  load(bookId: string): void {
    this.bookId = bookId
    const d = local.get<Data>(`ann:${bookId}`, { bookmarks: [], highlights: [] })
    this.d = { bookmarks: d.bookmarks ?? [], highlights: d.highlights ?? [] }
    this.emit()
  }

  private save(): void {
    local.set(`ann:${this.bookId}`, this.d)
    this.emit()
  }

  private emit(): void { for (const l of this.listeners) l() }
  on(l: () => void): void { this.listeners.push(l) }

  get bookmarks(): Bookmark[] { return [...this.d.bookmarks].sort((a, b) => a.ch - b.ch || a.s - b.s) }
  get highlights(): Highlight[] { return [...this.d.highlights].sort((a, b) => a.ch - b.ch || a.w0 - b.w0) }

  bookmarkAt(ch: number, s: number): Bookmark | undefined { return this.d.bookmarks.find((b) => b.ch === ch && b.s === s) }

  /** Ставит или снимает закладку. Возвращает true, если закладка добавлена. */
  toggleBookmark(ch: number, s: number, label: string, snippet: string): boolean {
    const ex = this.bookmarkAt(ch, s)
    if (ex) { this.removeBookmark(ex.id); return false }
    this.d.bookmarks.push({ id: uid(), ch, s, created: Date.now(), label, snippet })
    this.save()
    return true
  }

  removeBookmark(id: string): void {
    this.d.bookmarks = this.d.bookmarks.filter((b) => b.id !== id)
    this.save()
  }

  addHighlight(h: Omit<Highlight, 'id' | 'created'>): Highlight {
    // Пересекающиеся выделения той же главы сливаются в новое.
    const over = this.d.highlights.filter((x) => x.ch === h.ch && x.w0 < h.w1 && h.w0 < x.w1)
    const note = [...over.map((x) => x.note), h.note].filter(Boolean).join('\n\n')
    this.d.highlights = this.d.highlights.filter((x) => !over.includes(x))
    const nh: Highlight = { ...h, note, id: uid(), created: Date.now() }
    this.d.highlights.push(nh)
    this.save()
    return nh
  }

  updateHighlight(id: string, patch: Partial<Pick<Highlight, 'color' | 'note'>>): void {
    const h = this.d.highlights.find((x) => x.id === id)
    if (!h) return
    Object.assign(h, patch)
    this.save()
  }

  removeHighlight(id: string): void {
    this.d.highlights = this.d.highlights.filter((x) => x.id !== id)
    this.save()
  }

  highlightAt(ch: number, w: number): Highlight | undefined {
    return this.d.highlights.find((x) => x.ch === ch && x.w0 <= w && w < x.w1)
  }
}

export const annotations = new Annotations()

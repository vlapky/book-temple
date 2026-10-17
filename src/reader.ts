import type { Book, Position } from './book/types'
import { analyzeChapter, type ChapterData } from './text/segment'
import { settings } from './settings'
import { annotations, HL_COLORS } from './annotations'
import { esc, prefersReducedMotion } from './ui/dom'

const hasHighlightApi = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'

export class Reader {
  book!: Book
  ch = 0
  chunk = 0
  chunkCount = 1
  /** Позиция чтения: предложение под линией взгляда или текущее у TTS. */
  pos: Position = { ch: 0, s: 0 }

  onPosition: (p: Position) => void = () => {}
  onChapter: (ch: number) => void = () => {}

  private cache = new Map<number, ChapterData>()
  private sentEls: HTMLElement[] = []
  private wordEls: HTMLElement[] = []
  private blockEls: HTMLElement[] = []
  private chunkEls: HTMLElement[] = []
  private chunkOfSent: number[] = []
  private ttsSent: HTMLElement | null = null
  private ttsWord: HTMLElement | null = null
  private ttsBlock: HTMLElement | null = null
  private scrollRaf = 0
  /** Пока идёт программная прокрутка, позицию из скролла не пересчитываем. */
  private lockUntil = 0

  readonly el: HTMLElement

  constructor(el: HTMLElement) {
    this.el = el
    window.addEventListener('scroll', () => {
      cancelAnimationFrame(this.scrollRaf)
      this.scrollRaf = requestAnimationFrame(() => this.detectPosition())
    }, { passive: true })
    settings.on((_, ch) => {
      if (ch.some((k) => k === 'chunking' || k === 'chunkWords')) this.rerender()
      if (ch.includes('chunkSingle')) this.applyChunkMode()
    })
    annotations.on(() => this.paintAnnotations())
  }

  chapterCount(): number { return this.book.chapters.length }

  data(ch: number): ChapterData {
    let d = this.cache.get(ch)
    if (!d) {
      d = analyzeChapter(this.book.chapters[ch])
      this.cache.set(ch, d)
      if (this.cache.size > 8) {
        for (const k of this.cache.keys()) { if (k !== this.ch && k !== ch) { this.cache.delete(k); break } }
      }
    }
    return d
  }

  open(book: Book, pos: Position): void {
    this.book = book
    this.cache.clear()
    const ch = Math.min(Math.max(0, pos.ch), book.chapters.length - 1)
    this.showChapter(ch, { s: ch === pos.ch ? pos.s : 0, instant: true })
  }

  /** Показать главу; s — предложение, к которому прокрутить. */
  showChapter(ch: number, o: { s?: number; instant?: boolean; focus?: boolean } = {}): void {
    if (ch < 0 || ch >= this.book.chapters.length) return
    const changed = ch !== this.ch || !this.sentEls.length
    this.ch = ch
    if (changed) this.render()
    const s = Math.min(o.s ?? 0, Math.max(0, this.sentEls.length - 1))
    if (o.s != null && o.s > 0) this.scrollToSentence(s, { instant: o.instant ?? changed, align: 0.25 })
    else { this.lockScroll(); window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }) }
    this.setPos({ ch, s })
    if (changed) this.onChapter(ch)
    if (o.focus) this.el.focus({ preventScroll: true })
  }

  private rerender(): void {
    if (!this.book) return
    const s = this.pos.s
    this.render()
    this.scrollToSentence(s, { instant: true, align: 0.25 })
  }

  private render(): void {
    const ch = this.book.chapters[this.ch]
    const cd = this.data(this.ch)
    const s = settings.s
    const total = this.book.chapters.length
    const fnNums = new Map<string, number>()
    const fnRef = (id: string) => {
      if (!fnNums.has(id)) fnNums.set(id, fnNums.size + 1)
      const n = fnNums.get(id)!
      const a = `fn-${this.ch}-${n}`
      return `<sup class="fnref-wrap"><a class="fnref" href="#${a}" id="ref-${a}" role="doc-noteref" aria-label="Сноска ${n}">${n}</a></sup>`
    }

    // Разбивка на смысловые блоки по числу слов, на границах абзацев.
    const chunkOfBlock: number[] = []
    let chunkIdx = 0, acc = 0
    cd.blocks.forEach((b, i) => {
      const words = b.s0 < b.s1 ? cd.sents[b.s1 - 1].w1 - cd.sents[b.s0].w0 : 0
      if (s.chunking && acc > 0 && (acc + words > s.chunkWords * 1.25 || (b.k === 'h' && acc > s.chunkWords * 0.4))) { chunkIdx++; acc = 0 }
      chunkOfBlock[i] = chunkIdx
      acc += words
    })
    this.chunkCount = chunkIdx + 1

    const html: string[] = []
    html.push(`<header class="chapter-head"><p class="chapter-kicker">Глава ${this.ch + 1} из ${total}</p><h1 id="chTitle" class="chapter-title-h">${esc(ch.title)}</h1></header>`)
    let open = -1
    cd.blocks.forEach((b, bi) => {
      const c = chunkOfBlock[bi]
      if (c !== open) {
        if (open >= 0) html.push(this.chunkFooter(open), '</section>')
        open = c
        const label = s.chunking ? `<p class="chunk-label" aria-hidden="true">Блок ${c + 1} из ${this.chunkCount}</p>` : ''
        html.push(`<section class="chunk" data-chunk="${c}"${s.chunking ? ` aria-label="Блок ${c + 1} из ${this.chunkCount}"` : ''}>${label}`)
      }
      if (b.k === 'sep') { html.push(`<hr class="blk sep" data-b="${bi}">`); return }
      const inner: string[] = []
      for (let si = b.s0; si < b.s1; si++) {
        const st = cd.sents[si]
        let sh = ''
        for (const t of st.toks) {
          if (t.k === 'w') sh += `<span class="w" data-w="${t.i}">${esc(cd.words[t.i].t)}</span>`
          else if (t.k === 't') sh += esc(t.v)
          else sh += fnRef(t.id)
        }
        inner.push(`<span class="s" data-s="${si}">${sh}</span>`)
      }
      const body = inner.join(b.k === 'verse' ? '' : ' ')
      if (b.k === 'h') {
        const lvl = Math.min(6, (b.lvl ?? 1) + 1)
        html.push(`<h${lvl} class="blk" data-b="${bi}">${body}</h${lvl}>`)
      } else if (b.k === 'quote') html.push(`<blockquote class="blk" data-b="${bi}"><p>${body}</p></blockquote>`)
      else html.push(`<p class="blk${b.k === 'verse' ? ' verse' : ''}" data-b="${bi}">${body}</p>`)
    })
    if (open >= 0) html.push(this.chunkFooter(open), '</section>')

    if (fnNums.size) {
      html.push('<section class="footnotes" role="doc-endnotes" aria-labelledby="fnTitle"><h2 id="fnTitle">Сноски</h2><ol>')
      for (const [id, n] of fnNums) {
        const a = `fn-${this.ch}-${n}`
        html.push(`<li id="${a}" role="doc-footnote">${esc(this.book.notes[id] ?? 'Текст сноски не найден')} <a href="#ref-${a}" role="doc-backlink" class="backlink" aria-label="Вернуться к тексту">↩</a></li>`)
      }
      html.push('</ol></section>')
    }

    html.push('<nav class="chapter-nav" aria-label="Переход между главами">')
    html.push(this.ch > 0 ? `<button type="button" class="btn" data-goto-chapter="${this.ch - 1}">← ${esc(this.book.chapters[this.ch - 1].title)}</button>` : '<span></span>')
    html.push(this.ch < total - 1 ? `<button type="button" class="btn primary" data-goto-chapter="${this.ch + 1}">${esc(this.book.chapters[this.ch + 1].title)} →</button>` : '<p class="book-end">Конец книги</p>')
    html.push('</nav>')

    this.el.innerHTML = html.join('')
    this.sentEls = []
    for (const e of this.el.querySelectorAll<HTMLElement>('.s')) this.sentEls[+e.dataset.s!] = e
    this.wordEls = Array.from(this.el.querySelectorAll<HTMLElement>('.w'))
    this.blockEls = []
    for (const e of this.el.querySelectorAll<HTMLElement>('.blk')) this.blockEls[+e.dataset.b!] = e
    this.chunkEls = Array.from(this.el.querySelectorAll<HTMLElement>('.chunk'))
    this.chunkOfSent = cd.sents.map((st) => chunkOfBlock[st.b])
    this.ttsSent = this.ttsWord = this.ttsBlock = null
    this.chunk = Math.min(this.chunk, this.chunkCount - 1)
    this.applyChunkMode()
    this.paintAnnotations()
  }

  private chunkFooter(c: number): string {
    if (!settings.s.chunking) return ''
    const prev = c > 0 ? `<button type="button" class="btn" data-goto-chunk="${c - 1}">← Предыдущий блок</button>` : '<span></span>'
    const next = c < this.chunkCount - 1 ? `<button type="button" class="btn primary" data-goto-chunk="${c + 1}">Следующий блок →</button>` : ''
    return `<div class="chunk-nav">${prev}${next}</div>`
  }

  private applyChunkMode(): void {
    const single = settings.s.chunking && settings.s.chunkSingle
    this.el.classList.toggle('chunked', settings.s.chunking)
    this.el.classList.toggle('single-chunk', single)
    this.chunkEls.forEach((c, i) => c.classList.toggle('current', i === this.chunk))
  }

  showChunk(c: number, focus = true): void {
    if (c < 0 || c >= this.chunkCount) return
    this.chunk = c
    this.applyChunkMode()
    const el = this.chunkEls[c]
    if (!el) return
    if (settings.s.chunkSingle && settings.s.chunking) {
      this.lockScroll()
      window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + scrollY - this.topInset() - 16), behavior: 'instant' as ScrollBehavior })
    } else this.scrollToEl(el, { align: 0.08 })
    if (focus) {
      const first = el.querySelector<HTMLElement>('.s')
      if (first) this.setPos({ ch: this.ch, s: +first.dataset.s! })
      el.setAttribute('tabindex', '-1')
      el.focus({ preventScroll: true })
    }
  }

  /** Отступ сверху под панель инструментов. */
  topInset(): number {
    const top = document.getElementById('topbar')
    return top && !document.body.classList.contains('focus-mode') ? top.getBoundingClientRect().bottom : 0
  }

  bottomInset(): number {
    const p = document.getElementById('player')
    return p && !document.body.classList.contains('focus-mode') ? Math.max(0, innerHeight - p.getBoundingClientRect().top) : 0
  }

  private lockScroll(ms = 120): void { this.lockUntil = performance.now() + ms }

  scrollToEl(el: Element, o: { instant?: boolean; align?: number } = {}): void {
    const r = el.getBoundingClientRect()
    const top = this.topInset()
    const view = innerHeight - top - this.bottomInset()
    const y = r.top + scrollY - top - view * (o.align ?? 0.3)
    const instant = o.instant || prefersReducedMotion()
    this.lockScroll(instant ? 120 : 700)
    window.scrollTo({ top: Math.max(0, y), behavior: (instant ? 'instant' : 'smooth') as ScrollBehavior })
  }

  scrollToSentence(s: number, o: { instant?: boolean; align?: number } = {}): void {
    const c = this.chunkOfSent[s]
    if (c != null && c !== this.chunk) { this.chunk = c; this.applyChunkMode() }
    const el = this.sentEls[s]
    if (el) this.scrollToEl(el, o)
  }

  sentenceEl(s: number): HTMLElement | undefined { return this.sentEls[s] }
  wordEl(w: number): HTMLElement | undefined { return this.wordEls[w] }

  private setPos(p: Position): void {
    this.pos = p
    const c = this.chunkOfSent[p.s]
    if (c != null && c !== this.chunk && !(settings.s.chunking && settings.s.chunkSingle)) {
      this.chunk = c
      this.applyChunkMode()
    }
    this.onPosition(p)
  }

  /** Позиция чтения по прокрутке: предложение под «линией взгляда». */
  detectPosition(force = false): void {
    if (!this.sentEls.length || (!force && performance.now() < this.lockUntil) || this.ttsSent) return
    const line = this.readingLineY()
    let lo = 0, hi = this.sentEls.length - 1
    if (settings.s.chunking && settings.s.chunkSingle) {
      lo = this.chunkOfSent.indexOf(this.chunk)
      hi = this.chunkOfSent.lastIndexOf(this.chunk)
      if (lo < 0) return
    }
    let ans = hi
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const el = this.sentEls[mid]
      if (!el) { lo = mid + 1; continue }
      if (el.getBoundingClientRect().bottom >= line) { ans = mid; hi = mid - 1 } else lo = mid + 1
    }
    if (ans !== this.pos.s || this.pos.ch !== this.ch) this.setPos({ ch: this.ch, s: ans })
  }

  readingLineY(): number {
    const top = this.topInset()
    return top + (innerHeight - top - this.bottomInset()) * 0.3
  }

  // ---------- Подсветка озвучивания ----------

  markTts(p: Position | null, w = -1): void {
    if (!p || p.ch !== this.ch) {
      this.ttsSent?.classList.remove('tts-s')
      this.ttsWord?.classList.remove('tts-w')
      this.ttsBlock?.classList.remove('tts-b')
      this.ttsSent = this.ttsWord = this.ttsBlock = null
      return
    }
    const sEl = this.sentEls[p.s] ?? null
    const c = this.chunkOfSent[p.s]
    if (c != null && c !== this.chunk) { this.chunk = c; this.applyChunkMode() }
    if (sEl !== this.ttsSent) {
      this.ttsSent?.classList.remove('tts-s')
      sEl?.classList.add('tts-s')
      this.ttsSent = sEl
      const bEl = (sEl?.closest('.blk') as HTMLElement | null) ?? null
      if (bEl !== this.ttsBlock) { this.ttsBlock?.classList.remove('tts-b'); bEl?.classList.add('tts-b'); this.ttsBlock = bEl }
      this.setPos(p)
    }
    const wEl = w >= 0 ? this.wordEls[w] ?? null : null
    if (wEl !== this.ttsWord) {
      this.ttsWord?.classList.remove('tts-w')
      wEl?.classList.add('tts-w')
      this.ttsWord = wEl
    }
    if (settings.s.autoScroll) this.autoScroll(wEl ?? sEl)
  }

  get ttsElement(): HTMLElement | null { return this.ttsWord ?? this.ttsSent }
  get ttsBlockElement(): HTMLElement | null { return this.ttsBlock }

  private autoScroll(el: HTMLElement | null): void {
    if (!el) return
    const r = el.getBoundingClientRect()
    const top = this.topInset(), bottom = innerHeight - this.bottomInset()
    const h = bottom - top
    if (r.top < top + h * 0.12 || r.bottom > top + h * 0.7) this.scrollToEl(el, { align: 0.3 })
  }

  // ---------- Закладки и выделения ----------

  paintAnnotations(): void {
    if (!this.book) return
    for (const e of this.el.querySelectorAll('.has-bm')) e.classList.remove('has-bm')
    for (const e of this.el.querySelectorAll('.note-btn')) e.remove()
    for (const e of this.el.querySelectorAll('[class*="hl-"]')) e.classList.remove(...HL_COLORS.map((c) => `hl-${c.id}`))
    for (const b of annotations.bookmarks) {
      if (b.ch !== this.ch) continue
      this.sentEls[b.s]?.closest('.blk')?.classList.add('has-bm')
    }
    const groups = new Map<string, Range[]>()
    for (const h of annotations.highlights) {
      if (h.ch !== this.ch) continue
      const a = this.wordEls[h.w0], z = this.wordEls[h.w1 - 1]
      if (!a || !z) continue
      if (hasHighlightApi) {
        const r = new Range()
        r.setStartBefore(a)
        r.setEndAfter(z)
        const k = `hl-${h.color}`
        groups.set(k, [...(groups.get(k) ?? []), r])
      } else {
        for (let w = h.w0; w < h.w1; w++) this.wordEls[w]?.classList.add(`hl-${h.color}`)
      }
      if (h.note) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'note-btn'
        btn.dataset.hl = h.id
        btn.title = h.note
        btn.setAttribute('aria-label', `Заметка: ${h.note.slice(0, 80)}`)
        btn.textContent = '✎'
        z.after(btn)
      }
    }
    if (hasHighlightApi) {
      for (const c of HL_COLORS) {
        const rs = groups.get(`hl-${c.id}`)
        if (rs?.length) CSS.highlights.set(`hl-${c.id}`, new Highlight(...rs))
        else CSS.highlights.delete(`hl-${c.id}`)
      }
    }
  }

  /** Слова выделения: индексы [w0, w1) или null, если выделение вне текста. */
  selectionWords(): { w0: number; w1: number; text: string } | null {
    const sel = getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null
    const r = sel.getRangeAt(0)
    if (!this.el.contains(r.commonAncestorContainer)) return null
    const words = this.wordEls.filter((w) => r.intersectsNode(w))
    // intersectsNode ловит слова, которых выделение лишь касается краем, — их отбрасываем.
    const first = words[0], last = words[words.length - 1]
    if (first && r.startContainer === first.firstChild && r.startOffset >= (first.textContent?.length ?? 0)) words.shift()
    if (last && words.length && r.endContainer === last.firstChild && r.endOffset === 0) words.pop()
    if (!words.length) return null
    const w0 = +words[0].dataset.w!, w1 = +words[words.length - 1].dataset.w! + 1
    return { w0, w1, text: sel.toString().trim() }
  }

  /** Индекс предложения по слову. */
  sentenceOfWord(w: number): number { return this.data(this.ch).words[w]?.s ?? 0 }

  flash(el: Element): void {
    el.classList.remove('flash')
    void (el as HTMLElement).offsetWidth
    el.classList.add('flash')
  }
}

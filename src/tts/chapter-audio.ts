// Озвучка целых глав заранее — для устройств, где синтез идёт медленнее воспроизведения.
// Очередь: текущая глава и три следующие; хранятся ещё две предыдущие. Звук — в IndexedDB.
import { audioDb } from '../storage'
import { settings } from '../settings'
import { userPronunciationsSignature } from '../text/normalize'
import { wavBlob, type Clip, type SentencePcm, type SpeechSource } from './engine'

const AHEAD = 3
const BEHIND = 2

export interface ChapterJob {
  ch: number
  /** Номер главы в очереди (1..of) — «1/4», «2/4»… */
  index: number
  of: number
  done: number
  total: number
}

interface Synth {
  readonly loaded: boolean
  synthPcm(ch: number, s: number): Promise<SentencePcm>
}

export class ChapterAudio {
  private bookId = ''
  private cur = 0
  /** Меняется при любой смене плана (глава, книга, настройки) — цикл начинает заново по приоритету. */
  private token = 0
  private running = false
  private ready = new Set<number>()
  private waiters = new Map<number, (() => void)[]>()
  job: ChapterJob | null = null
  /** Воспроизведение ждёт эту главу. */
  waitingFor: number | null = null
  onChange: () => void = () => {}

  private src: SpeechSource
  private synth: Synth

  constructor(src: SpeechSource, synth: Synth) {
    this.src = src
    this.synth = synth
  }

  get enabled(): boolean { return settings.s.wholeChapter && settings.s.engine === 'vosk' }
  get current(): number { return this.cur }
  get loaded(): boolean { return this.synth.loaded }
  isReady(ch: number): boolean { return this.ready.has(ch) }

  /** Отпечаток всего, что влияет на звук: голос, темп, выразительность, словарь. */
  private gen(): string {
    const s = settings.s
    return `${s.voskVoice}|${s.speechRate}|${s.expressiveness}|${userPronunciationsSignature()}`
  }

  private emit(): void { this.onChange() }

  async setBook(bookId: string, ch: number): Promise<void> {
    this.token++
    this.bookId = bookId
    this.cur = ch
    this.ready.clear()
    this.job = null
    this.waitingFor = null
    this.waiters.clear()
    if (!this.enabled) { this.emit(); return }
    await audioDb.deleteOtherBooks(bookId).catch(() => {})
    await this.refreshReady()
    this.kick()
  }

  setCurrent(ch: number): void {
    if (ch === this.cur) return
    this.cur = ch
    this.token++
    if (!this.enabled) return
    this.cleanup().catch(() => {})
    this.refreshReady().then(() => this.kick())
  }

  /** Сменились голос, темп, выразительность или словарь: готовый звук устарел. */
  invalidate(): void {
    this.token++
    this.ready.clear()
    this.job = null
    if (this.enabled) this.kick()
    this.emit()
  }

  async regenerate(ch: number): Promise<void> {
    this.token++
    this.ready.delete(ch)
    await audioDb.deleteChapter(this.bookId, ch).catch(() => {})
    this.kick()
    this.emit()
  }

  /** Галочку сняли: удалить всю сохранённую озвучку. */
  async clearAll(): Promise<void> {
    this.token++
    this.ready.clear()
    this.job = null
    this.waitingFor = null
    this.waiters.clear()
    await audioDb.clear().catch(() => {})
    this.emit()
  }

  /** Главы, которые готовим, по приоритету: текущая и следующие. */
  private order(): number[] {
    const n = this.src.chapterCount()
    const out: number[] = []
    for (let c = this.cur; c < Math.min(n, this.cur + AHEAD + 1); c++) out.push(c)
    // Если ждём главу вне окна (переход по оглавлению), она первая.
    if (this.waitingFor != null && !out.includes(this.waitingFor)) out.unshift(this.waitingFor)
    return out
  }

  private async refreshReady(): Promise<void> {
    const g = this.gen()
    for (const ch of this.order()) {
      const m = await audioDb.getMeta(this.bookId, ch).catch(() => undefined)
      if (m && m.gen === g && m.done) this.ready.add(ch)
    }
    this.emit()
  }

  /** Удалить главы вне окна «2 назад — 3 вперёд». */
  private async cleanup(): Promise<void> {
    const book = this.bookId
    for (const ch of await audioDb.chapters(book)) {
      if (ch < this.cur - BEHIND || ch > this.cur + AHEAD) {
        if (ch === this.waitingFor) continue
        await audioDb.deleteChapter(book, ch)
        this.ready.delete(ch)
      }
    }
  }

  /** Запустить фоновую озвучку, если она ещё не идёт. */
  kick(): void {
    if (!this.enabled || !this.synth.loaded || this.running || !this.bookId) { this.emit(); return }
    this.running = true
    this.loop().catch((e) => console.warn('Озвучка главы:', e)).finally(() => {
      this.running = false
      this.job = null
      this.emit()
    })
  }

  private async loop(): Promise<void> {
    for (;;) {
      const my = this.token
      const order = this.order()
      for (let k = 0; k < order.length; k++) {
        if (my !== this.token || !this.enabled) break
        const ch = order[k]
        if (this.ready.has(ch)) continue
        await this.generate(ch, k + 1, order.length, my)
      }
      // План не менялся, пока мы работали, — всё готово.
      if (my === this.token || !this.enabled) return
    }
  }

  private async generate(ch: number, index: number, of: number, my: number): Promise<void> {
    const book = this.bookId
    const g = this.gen()
    const cd = this.src.data(ch)
    const total = cd.sents.filter((x) => x.w1 > x.w0).length
    let start = 0
    const meta = await audioDb.getMeta(book, ch)
    if (meta && meta.gen === g) {
      if (meta.done) { this.markReady(ch); return }
      start = meta.next
    } else if (meta) await audioDb.deleteChapter(book, ch)

    let done = cd.sents.slice(0, start).filter((x) => x.w1 > x.w0).length
    this.job = { ch, index, of, done, total }
    this.emit()
    for (let s = start; s < cd.sents.length; s++) {
      if (my !== this.token || !this.enabled) return
      const sent = cd.sents[s]
      if (sent.w1 > sent.w0) {
        const r = await this.synth.synthPcm(ch, s)
        // Пока шёл синтез, могли сменить книгу или голос — такой звук не сохраняем.
        if (this.bookId !== book || this.gen() !== g) return
        await audioDb.put(book, ch, s, { wav: wavBlob(r.pcm, r.rate), w0: r.w0, starts: Array.from(r.starts), dur: r.pcm.length / r.rate })
        done++
      }
      await audioDb.putMeta(book, ch, { gen: g, next: s + 1, done: false })
      this.job = { ch, index, of, done, total }
      this.emit()
    }
    await audioDb.putMeta(book, ch, { gen: g, next: cd.sents.length, done: true })
    this.markReady(ch)
  }

  private markReady(ch: number): void {
    this.ready.add(ch)
    const ws = this.waiters.get(ch) ?? []
    this.waiters.delete(ch)
    for (const w of ws) w()
    this.emit()
  }

  /** Звук предложения из готовой главы; если глава не готова — ждём её озвучку. */
  async clip(ch: number, s: number): Promise<Clip> {
    if (!this.ready.has(ch)) {
      this.waitingFor = ch
      if (ch < this.cur || ch > this.cur + AHEAD) this.setCurrent(ch)
      else { this.token++; this.kick() }
      this.emit()
      await new Promise<void>((res) => {
        const ws = this.waiters.get(ch) ?? []
        ws.push(res)
        this.waiters.set(ch, ws)
      })
      if (this.waitingFor === ch) this.waitingFor = null
      this.emit()
    }
    const a = await audioDb.get(this.bookId, ch, s)
    if (!a) throw new Error('Нет звука предложения в готовой главе')
    return { url: URL.createObjectURL(a.wav), w0: a.w0, starts: Float32Array.from(a.starts), dur: a.dur }
  }
}

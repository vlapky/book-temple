import type { Reader } from '../reader'
import type { Position } from '../book/types'
import { settings } from '../settings'
import { $, esc } from './dom'
import { icon } from './icons'

/** Точка оптимального распознавания: буква, на которой фиксируется взгляд. */
function orp(len: number): number {
  if (len <= 1) return 0
  if (len <= 5) return 1
  if (len <= 9) return 2
  if (len <= 13) return 3
  return 4
}

export class Rsvp {
  open = false
  private ch = 0
  private w = 0
  private timer = 0
  private playing = false
  private el = $('rsvp')
  private opener: HTMLElement | null = null
  onClose: (p: Position) => void = () => {}

  private reader: Reader

  constructor(reader: Reader) {
    this.reader = reader
    $('rsvpClose').onclick = () => this.close()
    $('rsvpPlay').onclick = () => this.toggle()
    $('rsvpBack').onclick = () => this.step(-1)
    $('rsvpFwd').onclick = () => this.step(1)
    $('rsvpStage').onclick = () => this.toggle()
    const wpm = $<HTMLInputElement>('rsvpWpm')
    wpm.oninput = () => settings.set({ rsvpWpm: +wpm.value })
    settings.on((_, ch) => {
      if (ch.includes('rsvpWpm')) this.syncWpm()
      if (this.open && (ch.includes('rsvpWords') || ch.includes('rsvpContext'))) this.show()
    })
    // Фокус не выходит за пределы окна RSVP.
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return
      const f = Array.from(this.el.querySelectorAll<HTMLElement>('button, input'))
      const i = f.indexOf(document.activeElement as HTMLElement)
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus() }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus() }
    })
  }

  private syncWpm(): void {
    const v = settings.s.rsvpWpm
    $<HTMLInputElement>('rsvpWpm').value = String(v)
    $('rsvpWpmOut').textContent = String(v)
    $<HTMLInputElement>('rsvpWpm').setAttribute('aria-valuetext', `${v} слов в минуту`)
  }

  start(p: Position): void {
    this.opener = document.activeElement as HTMLElement | null
    this.ch = p.ch
    const cd = this.reader.data(p.ch)
    this.w = cd.sents[p.s]?.w0 ?? 0
    this.open = true
    this.el.hidden = false
    document.body.style.overflow = 'hidden'
    this.syncWpm()
    this.show()
    $('rsvpPlay').focus()
  }

  close(): void {
    if (!this.open) return
    this.pause()
    this.open = false
    this.el.hidden = true
    document.body.style.overflow = ''
    const s = this.reader.data(this.ch).words[this.w]?.s ?? 0
    this.onClose({ ch: this.ch, s })
    ;(this.opener && document.contains(this.opener) ? this.opener : $('content')).focus({ preventScroll: true })
  }

  toggle(): void { if (this.playing) this.pause(); else this.play() }

  play(): void {
    if (this.playing) return
    this.playing = true
    this.setPlayIcon()
    this.tick()
  }

  pause(): void {
    this.playing = false
    clearTimeout(this.timer)
    this.setPlayIcon()
  }

  private setPlayIcon(): void {
    const b = $('rsvpPlay')
    b.innerHTML = icon(this.playing ? 'pause' : 'play')
    b.setAttribute('aria-label', this.playing ? 'Пауза' : 'Старт')
  }

  /** Сдвиг на n показов (слов или групп). */
  step(n: number): void {
    const k = settings.s.rsvpWords
    this.move(n * k)
    this.show()
  }

  speed(delta: number): void {
    settings.set({ rsvpWpm: Math.min(1000, Math.max(100, settings.s.rsvpWpm + delta)) })
  }

  private move(dw: number): void {
    let cd = this.reader.data(this.ch)
    this.w += dw
    if (this.w >= cd.words.length) {
      if (this.ch + 1 < this.reader.chapterCount()) { this.ch++; this.w = 0 }
      else { this.w = cd.words.length - 1; this.pause() }
    } else if (this.w < 0) {
      if (this.ch > 0) { this.ch--; cd = this.reader.data(this.ch); this.w = Math.max(0, cd.words.length + this.w) }
      else this.w = 0
    }
  }

  private tick(): void {
    if (!this.playing) return
    const delay = this.show()
    this.timer = window.setTimeout(() => {
      const before = `${this.ch}:${this.w}`
      this.move(settings.s.rsvpWords)
      if (`${this.ch}:${this.w}` === before) { this.pause(); return }
      this.tick()
    }, delay)
  }

  /** Отрисовать текущее слово; вернуть время показа в мс. */
  private show(): number {
    const cd = this.reader.data(this.ch)
    const k = settings.s.rsvpWords
    const words = cd.words.slice(this.w, this.w + k)
    if (!words.length) return 300
    const box = $('rsvpWord')
    const [l, c, r] = box.children as unknown as HTMLElement[]
    if (k === 1) {
      const d = words[0].disp
      const lead = d.match(/^[^\p{L}\p{N}]*/u)?.[0].length ?? 0
      const core = words[0].t
      const i = Math.min(d.length - 1, lead + orp(core.length))
      l.textContent = d.slice(0, i)
      c.textContent = d[i] ?? ''
      r.textContent = d.slice(i + 1)
    } else {
      // Несколько слов: центрируем по середине группы.
      const text = words.map((x) => x.disp).join(' ')
      const i = Math.floor(text.length / 2)
      l.textContent = text.slice(0, i)
      c.textContent = text[i] ?? ''
      r.textContent = text.slice(i + 1)
    }
    const last = words[words.length - 1]
    const sent = cd.sents[last.s]
    if (settings.s.rsvpContext && sent) {
      const html = cd.words.slice(sent.w0, sent.w1).map((x, j) => {
        const wi = sent.w0 + j
        return wi >= this.w && wi < this.w + k ? `<span class="cur">${esc(x.disp)}</span>` : esc(x.disp)
      }).join(' ')
      $('rsvpContext').innerHTML = html
    } else $('rsvpContext').textContent = ''
    const total = cd.words.length
    $('rsvpProgress').textContent = `Глава ${this.ch + 1} из ${this.reader.chapterCount()}, прочитано ${Math.round((this.w / Math.max(1, total)) * 100)}%, до конца главы около ${Math.max(1, Math.round((total - this.w) / settings.s.rsvpWpm))} мин`

    // Длительность: длинные слова и паузы на знаках препинания показываются дольше.
    const base = (60000 / settings.s.rsvpWpm) * k
    let mult = 1
    const len = words.reduce((a, x) => a + x.t.length, 0) / k
    if (len > 8) mult += 0.3
    if (len > 12) mult += 0.3
    if (last.pause === 2) mult += 1.2
    else if (last.pause === 1) mult += 0.5
    const next = cd.words[this.w + k]
    if (!next || next.b !== last.b) mult += 0.8
    return base * mult
  }
}

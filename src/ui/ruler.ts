import type { Reader } from '../reader'
import { settings } from '../settings'
import { $ } from './dom'

/**
 * Направляющая линейка. «Строка» — затемнение всего, кроме полосы;
 * «абзац» — приглушение всех абзацев, кроме текущего.
 * Следует за голосом, иначе — за мышью, иначе — за линией взгляда при прокрутке.
 */
export class Ruler {
  private el = $('ruler')
  private pointerY: number | null = null
  private pointerAt = 0
  private raf = 0
  private activeBlock: Element | null = null

  private reader: Reader

  constructor(reader: Reader) {
    this.reader = reader
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return
      this.pointerY = e.clientY
      this.pointerAt = performance.now()
      this.schedule()
    }, { passive: true })
    window.addEventListener('scroll', () => this.schedule(), { passive: true })
    window.addEventListener('resize', () => this.schedule())
    settings.on((_, ch) => { if (ch.some((k) => k.startsWith('ruler') || k === 'fontSize' || k === 'lineHeight')) this.apply() })
    this.apply()
  }

  apply(): void {
    const mode = settings.s.ruler
    this.el.hidden = mode !== 'line'
    this.reader.el.classList.toggle('ruler-paragraph', mode === 'paragraph')
    if (mode !== 'paragraph') { this.activeBlock?.classList.remove('ruler-active'); this.activeBlock = null }
    this.update()
  }

  schedule(): void {
    if (settings.s.ruler === 'off') return
    cancelAnimationFrame(this.raf)
    this.raf = requestAnimationFrame(() => this.update())
  }

  private lineHeightPx(): number {
    return settings.s.fontSize * settings.s.lineHeight
  }

  /** Верх строки текста, проходящей через y (по фрагментам строк ближайшего предложения). */
  private lineTopAt(y: number): number | null {
    const box = this.reader.el.getBoundingClientRect()
    const lh = this.lineHeightPx()
    for (const dy of [0, -lh / 3, lh / 3]) {
      const el = document.elementFromPoint(box.left + box.width / 2, y + dy)?.closest('.s')
      if (!el) continue
      for (const r of el.getClientRects()) {
        if (y + dy >= r.top && y + dy <= r.bottom) return r.top + r.height / 2 - lh / 2
      }
    }
    return null
  }

  update(): void {
    const mode = settings.s.ruler
    if (mode === 'off') return
    const tts = this.reader.ttsElement
    const pointerFresh = this.pointerY != null && performance.now() - this.pointerAt < 4000
    if (mode === 'line') {
      const lh = this.lineHeightPx()
      const h = lh * settings.s.rulerLines
      let top: number
      if (tts) {
        // Текущая строка голоса — верхняя в окне линейки.
        const r = tts.getBoundingClientRect()
        top = r.top + r.height / 2 - lh / 2
      } else {
        const y = pointerFresh ? this.pointerY! : this.reader.readingLineY()
        top = this.lineTopAt(y) ?? y - lh / 2
      }
      this.el.style.setProperty('--ruler-top', `${Math.round(top - 3)}px`)
      this.el.style.setProperty('--ruler-h', `${Math.round(h + 6)}px`)
      return
    }
    // Абзац
    let blk: Element | null = this.reader.ttsBlockElement
    if (!blk) {
      const y = pointerFresh ? this.pointerY! : this.reader.readingLineY()
      const x = this.reader.el.getBoundingClientRect().left + this.reader.el.clientWidth / 2
      blk = document.elementFromPoint(x, y)?.closest('.reader .blk') ?? null
      if (!blk) {
        const s = this.reader.sentenceEl(this.reader.pos.s)
        blk = s?.closest('.blk') ?? null
      }
    }
    if (blk !== this.activeBlock) {
      this.activeBlock?.classList.remove('ruler-active')
      blk?.classList.add('ruler-active')
      this.activeBlock = blk
    }
  }
}

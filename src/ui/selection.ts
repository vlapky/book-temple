import type { Reader } from '../reader'
import { annotations, HL_COLORS, type HlColor, type Highlight } from '../annotations'
import { $, toast } from './dom'
import { icon } from './icons'
import { noteDialog } from './dialog'

/** Плавающая панель над выделенным текстом: цвет, заметка, «читать отсюда». */
export class SelectionBar {
  private el = $('selbar')
  private sel: { w0: number; w1: number; text: string } | null = null
  private hl: Highlight | null = null

  private reader: Reader
  private readFrom: (s: number) => void

  constructor(reader: Reader, readFrom: (s: number) => void) {
    this.reader = reader
    this.readFrom = readFrom
    const content = reader.el
    const check = () => setTimeout(() => this.fromSelection(), 0)
    content.addEventListener('pointerup', check)
    content.addEventListener('keyup', (e) => { if (e.shiftKey) check() })
    content.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      const nb = t.closest<HTMLElement>('.note-btn')
      if (nb) { this.editNote(nb.dataset.hl!); return }
      const w = t.closest<HTMLElement>('.w')
      if (!w || !getSelection()?.isCollapsed) return
      const h = annotations.highlightAt(reader.ch, +w.dataset.w!)
      if (h) this.showFor(h, w)
    })
    document.addEventListener('selectionchange', () => {
      if (!this.el.hidden && !this.hl && getSelection()?.isCollapsed) this.hide()
    })
    document.addEventListener('pointerdown', (e) => {
      if (!this.el.hidden && !this.el.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.w')) this.hide()
    })
    // Кнопки не должны сбрасывать выделение.
    this.el.addEventListener('pointerdown', (e) => { if ((e.target as HTMLElement).closest('button')) e.preventDefault() })
    this.el.addEventListener('click', (e) => this.onClick(e))
    this.el.addEventListener('keydown', (e) => {
      const bs = Array.from(this.el.querySelectorAll<HTMLElement>('button'))
      const i = bs.indexOf(document.activeElement as HTMLElement)
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault()
        bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length]?.focus()
      }
    })
  }

  get visible(): boolean { return !this.el.hidden }

  hide(): void {
    this.el.hidden = true
    this.sel = null
    this.hl = null
  }

  private fromSelection(): void {
    const s = this.reader.selectionWords()
    if (!s) return
    this.sel = s
    this.hl = null
    const r = getSelection()!.getRangeAt(0).getBoundingClientRect()
    this.render()
    this.place(r)
  }

  private showFor(h: Highlight, anchor: HTMLElement): void {
    this.hl = h
    this.sel = null
    this.render()
    this.place(anchor.getBoundingClientRect())
    this.el.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
  }

  /** Показать для выделения, созданного с клавиатуры (например, H). */
  focusFor(h: Highlight): void {
    const el = this.reader.wordEl(h.w1 - 1)
    if (el) this.showFor(h, el)
  }

  private render(): void {
    const cur = this.hl?.color
    this.el.innerHTML = [
      ...HL_COLORS.map((c) => `<button type="button" class="dot ${c.id}" data-color="${c.id}" aria-label="${this.hl ? 'Цвет' : 'Выделить'}: ${c.name.toLowerCase()}" ${this.hl ? `aria-pressed="${cur === c.id}"` : ''}></button>`),
      '<span class="sep" aria-hidden="true"></span>',
      `<button type="button" class="sb" data-act="note">${icon('note')}${this.hl?.note ? 'Изменить заметку' : 'Заметка'}</button>`,
      this.sel ? `<button type="button" class="sb" data-act="read">${icon('play')}Читать отсюда</button>` : '',
      this.hl ? `<button type="button" class="sb" data-act="del">${icon('trash')}Удалить</button>` : '',
    ].join('')
    this.el.hidden = false
  }

  private place(r: DOMRect): void {
    const w = this.el.offsetWidth, h = this.el.offsetHeight
    let top = r.top + scrollY - h - 10
    if (r.top - h - 10 < this.reader.topInset()) top = r.bottom + scrollY + 10
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8)
    this.el.style.top = `${top}px`
    this.el.style.left = `${left + scrollX}px`
  }

  private async onClick(e: MouseEvent): Promise<void> {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button')
    if (!b) return
    const color = b.dataset.color as HlColor | undefined
    const act = b.dataset.act
    if (color) {
      if (this.hl) annotations.updateHighlight(this.hl.id, { color })
      else if (this.sel) {
        annotations.addHighlight({ ch: this.reader.ch, w0: this.sel.w0, w1: this.sel.w1, color, note: '', text: this.sel.text })
        getSelection()?.removeAllRanges()
      }
      this.hide()
    } else if (act === 'note') {
      let h = this.hl
      if (!h && this.sel) {
        h = annotations.addHighlight({ ch: this.reader.ch, w0: this.sel.w0, w1: this.sel.w1, color: 'yellow', note: '', text: this.sel.text })
        getSelection()?.removeAllRanges()
      }
      this.hide()
      if (h) await this.editNote(h.id)
    } else if (act === 'read' && this.sel) {
      const s = this.reader.sentenceOfWord(this.sel.w0)
      getSelection()?.removeAllRanges()
      this.hide()
      this.readFrom(s)
    } else if (act === 'del' && this.hl) {
      annotations.removeHighlight(this.hl.id)
      this.hide()
      toast('Выделение удалено')
    }
  }

  async editNote(id: string): Promise<void> {
    const h = annotations.highlights.find((x) => x.id === id)
    if (!h) return
    const note = await noteDialog(h.text, h.note)
    if (note != null) {
      annotations.updateHighlight(id, { note })
      if (note) toast('Заметка сохранена')
    }
  }
}

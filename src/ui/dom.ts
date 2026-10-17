export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c])

export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** Краткое уведомление. В режиме фокусировки не показывается (только для скринридера). */
export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  const box = $('toasts')
  if (document.body.classList.contains('focus-mode') && kind === 'info') {
    const sr = document.createElement('p')
    sr.className = 'sr-only'
    sr.textContent = text
    box.append(sr)
    setTimeout(() => sr.remove(), 4000)
    return
  }
  const t = document.createElement('div')
  t.className = `toast ${kind}`
  t.textContent = text
  box.append(t)
  setTimeout(() => t.classList.add('out'), kind === 'error' ? 6000 : 2600)
  setTimeout(() => t.remove(), kind === 'error' ? 6500 : 3100)
}

export const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 10, h = n % 100
  if (h >= 11 && h <= 14) return many
  if (d === 1) return one
  if (d >= 2 && d <= 4) return few
  return many
}

export function formatMinutes(min: number): string {
  if (min < 1) return 'меньше минуты'
  if (min < 60) { const m = Math.round(min); return `${m} ${plural(m, 'минута', 'минуты', 'минут')}` }
  const h = Math.floor(min / 60), m = Math.round(min % 60)
  return `${h} ч ${m} мин`
}

/** Открыт ли модальный слой, в котором глобальные клавиши не должны работать. */
export const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  if (el.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button', 'color'].includes((el as HTMLInputElement).type)
  return false
}

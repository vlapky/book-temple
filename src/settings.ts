import { local } from './storage'

export type ThemeId = 'day' | 'night' | 'sepia' | 'cream' | 'digital'
export type FontId = 'literata' | 'pt-serif' | 'fira-sans' | 'andika' | 'system'

export interface Settings {
  font: FontId
  fontSize: number
  lineHeight: number
  letterSpacing: number
  wordSpacing: number
  columnWidth: number
  paragraphSpacing: number
  align: 'left' | 'justify'
  theme: ThemeId
  contrast: number
  bgCustom: string
  fgCustom: string

  engine: 'vosk' | 'system'
  voskVoice: number
  systemVoice: string
  playbackRate: number
  speechRate: number
  expressiveness: number
  highlight: 'word' | 'sentence' | 'both'
  autoScroll: boolean
  backend: 'auto' | 'webgpu' | 'wasm'

  ruler: 'off' | 'line' | 'paragraph'
  rulerDim: number
  rulerLines: number
  chunking: boolean
  chunkWords: number
  chunkSingle: boolean

  rsvpWpm: number
  rsvpWords: number
  rsvpContext: boolean

  showPlayer: boolean
}

/** Тема по системной настройке устройства: тёмная → ночная, иначе дневная. */
function systemTheme(): ThemeId {
  try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day' } catch { return 'day' }
}

export const DEFAULTS: Settings = {
  font: 'literata',
  fontSize: 20,
  lineHeight: 1.7,
  letterSpacing: 0,
  wordSpacing: 0,
  columnWidth: 66,
  paragraphSpacing: 0.9,
  align: 'left',
  // Пока пользователь не выбрал тему сам, она следует за системой (и при сбросе тоже).
  theme: systemTheme(),
  contrast: 100,
  bgCustom: '',
  fgCustom: '',

  engine: 'vosk',
  voskVoice: 4,
  systemVoice: '',
  playbackRate: 1,
  speechRate: 1,
  expressiveness: 0.8,
  highlight: 'both',
  autoScroll: true,
  backend: 'auto',

  ruler: 'off',
  rulerDim: 0.55,
  rulerLines: 2,
  chunking: false,
  chunkWords: 150,
  chunkSingle: false,

  rsvpWpm: 300,
  rsvpWords: 1,
  rsvpContext: true,

  showPlayer: true,
}

export interface Theme { name: string; bg: string; fg: string; accent: string; rule: string }

// Тетрадь: бумага, чернила и красная линия полей.
export const THEMES: Record<ThemeId, Theme> = {
  day: { name: 'Дневная', bg: '#f7f8f5', fg: '#1f2330', accent: '#3540a8', rule: '#d9574f' },
  night: { name: 'Ночная', bg: '#1b1f27', fg: '#d6dae2', accent: '#9fb0f2', rule: '#a8524c' },
  sepia: { name: 'Сепия', bg: '#f1e6cf', fg: '#463626', accent: '#7c4b20', rule: '#b4533c' },
  cream: { name: 'Кремовая', bg: '#fff5dc', fg: '#2a251d', accent: '#5a3fa0', rule: '#cf5a45' },
  digital: { name: 'Цифровая', bg: '#000000', fg: '#3dff7a', accent: '#3dff7a', rule: '#145c2c' },
}

export const FONTS: Record<FontId, { name: string; stack: string; note?: string }> = {
  literata: { name: 'Literata', stack: "'Literata', Georgia, serif", note: 'книжный, спокойный' },
  'pt-serif': { name: 'PT Serif', stack: "'PT Serif', Georgia, serif", note: 'классическая антиква' },
  'fira-sans': { name: 'Fira Sans', stack: "'Fira Sans', system-ui, sans-serif", note: 'чёткий гротеск' },
  andika: { name: 'Andika', stack: "'Andika', 'Fira Sans', sans-serif", note: 'для дислексии' },
  system: { name: 'Системный', stack: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
}

type Listener = (s: Settings, changed: (keyof Settings)[]) => void

class Store {
  s: Settings
  private listeners: Listener[] = []
  private saveTimer = 0

  constructor() {
    const saved = local.get<Partial<Settings>>('settings', {})
    this.s = { ...DEFAULTS }
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) (this.s as unknown as Record<string, unknown>)[k] = saved[k]
    }
  }

  get<K extends keyof Settings>(k: K): Settings[K] { return this.s[k] }

  set(patch: Partial<Settings>): void {
    const changed = (Object.keys(patch) as (keyof Settings)[]).filter((k) => this.s[k] !== patch[k])
    if (!changed.length) return
    Object.assign(this.s, patch)
    for (const l of this.listeners) l(this.s, changed)
    clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => local.set('settings', this.s), 150)
  }

  reset(keys: (keyof Settings)[]): void {
    const patch: Partial<Settings> = {}
    for (const k of keys) (patch as Record<string, unknown>)[k] = DEFAULTS[k]
    this.set(patch)
  }

  on(l: Listener): void { this.listeners.push(l) }
}

export const settings = new Store()

// ---------- Цвета ----------

function hexToRgb(h: string): [number, number, number] {
  const m = h.replace('#', '')
  const n = parseInt(m.length === 3 ? m.split('').map((c) => c + c).join('') : m, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const toHex = (c: number[]) => '#' + c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')

export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a), y = hexToRgb(b)
  return toHex(x.map((v, i) => v * t + y[i] * (1 - t)))
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Итоговые цвета текста и фона с учётом пользовательских правок. */
/**
 * fg — цвет текста книги с учётом ползунка контраста;
 * baseFg — цвет темы (или свой) без приглушения: им рисуется интерфейс.
 */
export function effectiveColors(s: Settings): { bg: string; fg: string; baseFg: string; accent: string; dark: boolean } {
  const t = THEMES[s.theme]
  const bg = s.bgCustom || t.bg
  const baseFg = s.fgCustom || t.fg
  const fg = mix(baseFg, bg, s.contrast / 100)
  return { bg, fg, baseFg, accent: t.accent, dark: luminance(bg) < 0.2 }
}

/** Применяет настройки к документу через CSS-переменные. */
export function applySettings(s: Settings): void {
  const root = document.documentElement
  const { bg, fg, baseFg, accent, dark } = effectiveColors(s)
  const st = root.style
  st.setProperty('--bg', bg)
  // Контраст действует на весь интерфейс; --fg-base — цвет без приглушения (для ползунка контраста).
  st.setProperty('--fg', fg)
  st.setProperty('--text', fg)
  st.setProperty('--fg-base', baseFg)
  // Синие пометки (прогресс, маркер голоса, сноски) тоже следуют за контрастом.
  st.setProperty('--accent', mix(accent, bg, s.contrast / 100))
  st.setProperty('--rule', THEMES[s.theme].rule)
  st.setProperty('--r-font', FONTS[s.font].stack)
  st.setProperty('--r-size', `${s.fontSize}px`)
  st.setProperty('--r-lh', String(s.lineHeight))
  st.setProperty('--r-ls', `${s.letterSpacing}em`)
  st.setProperty('--r-ws', `${s.wordSpacing}em`)
  st.setProperty('--r-width', `${s.columnWidth}ch`)
  st.setProperty('--r-pgap', `${s.paragraphSpacing}em`)
  st.setProperty('--r-align', s.align)
  st.setProperty('--ruler-dim', String(s.rulerDim))
  root.dataset.theme = s.theme
  root.dataset.dark = String(dark)
  root.dataset.highlight = s.highlight
  root.style.colorScheme = dark ? 'dark' : 'light'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg)
}

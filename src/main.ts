import './fonts'
import './styles/main.css'
import type { Book, Position } from './book/types'
import { Reader } from './reader'
import { settings, applySettings } from './settings'
import { annotations } from './annotations'
import { Speech, type TtsState } from './tts/engine'
import { VOSK_VOICES, SAMPLE_PHRASE } from './tts/voices'
import { demoBook } from './book/demo'
import { parseFile, parsePlain } from './book/parse'
import { saveBook, loadBook, touchBook, local } from './storage'
import { $, toast, isTypingTarget, formatMinutes } from './ui/dom'
import { icon, hydrateIcons } from './ui/icons'
import { Panels, fillVoiceSelect, type AppApi } from './ui/panels'
import { Rsvp } from './ui/rsvp'
import { Ruler } from './ui/ruler'
import { SelectionBar } from './ui/selection'
import { askModelDialog, helpDialog } from './ui/dialog'

// ---------- Состояние ----------

let book: Book
const reader = new Reader($('content'))

applySettings(settings.s)
hydrateIcons()

const speech = new Speech(
  { chapterCount: () => reader.chapterCount(), data: (ch) => reader.data(ch) },
  {
    state: onTtsState,
    sentence(p) {
      if (p.ch !== reader.ch) reader.showChapter(p.ch, { s: p.s })
      reader.markTts(p)
      ruler.schedule()
    },
    word(ch, w) {
      if (speech.state === 'idle') reader.markTts(null)
      else if (speech.pos && speech.pos.ch === ch) reader.markTts(speech.pos, w)
      ruler.schedule()
    },
    loading(p, label) {
      const bar = $('loadBar')
      bar.hidden = p == null
      if (p == null) { updateStatus(); return }
      bar.classList.toggle('indeterminate', p === 0)
      ;(bar.firstElementChild as HTMLElement).style.width = `${Math.round(p * 100)}%`
      $('ttsStatus').textContent = p > 0 ? `${label}… ${Math.round(p * 100)}%` : `${label}…`
    },
    error: (msg) => toast(msg, 'error'),
    finished: () => toast('Книга дочитана до конца'),
    askModel: () => askModelDialog(Speech.systemAvailable()),
  },
)

const app: AppApi = {
  reader,
  speech,
  goTo,
  pickFile: () => $<HTMLInputElement>('fileInput').click(),
  openText: (title, text) => importBook(async () => parsePlain(text, title)),
  openBook: (id) => { openBookById(id).catch((e) => toast('Не удалось открыть книгу: ' + e.message, 'error')) },
  currentBookId: () => book?.id ?? '',
  position,
}

const panels = new Panels(app)
const rsvp = new Rsvp(reader)
const ruler = new Ruler(reader)
const selbar = new SelectionBar(reader, (s) => speech.play({ ch: reader.ch, s }))

/** Текущее место чтения: у голоса, если он активен, иначе под линией взгляда. */
function position(): Position {
  return speech.active && speech.pos ? speech.pos : reader.pos
}

// ---------- Книги ----------

async function openBookById(id: string): Promise<void> {
  if (id === 'demo') { await openBook(demoBook(), true); return }
  const b = await loadBook(id)
  if (!b) throw new Error('книга не найдена в библиотеке')
  await openBook(b)
}

async function openBook(b: Book, save = false): Promise<void> {
  speech.stop()
  reader.markTts(null)
  rsvp.close()
  selbar.hide()
  if (save) await saveBook(b).catch(() => {})
  else touchBook(b.id).catch(() => {})
  book = b
  annotations.load(b.id)
  local.set('lastBook', b.id)
  const pos = local.get<Position>(`pos:${b.id}`, { ch: 0, s: 0 })
  $('bookTitle').textContent = b.title
  document.title = `${b.title} — Комфорт ридер`
  reader.open(b, pos)
  updateProgress()
}

async function importBook(parse: () => Promise<Book>): Promise<void> {
  toast('Открываю книгу…')
  try {
    const b = await parse()
    await openBook(b, true)
    toast(`«${b.title}»: ${b.chapters.length} ${b.chapters.length === 1 ? 'глава' : 'глав(ы)'}`)
    $('content').focus({ preventScroll: true })
  } catch (e) {
    console.error(e)
    toast('Не удалось открыть файл: ' + ((e as Error).message || e), 'error')
  }
}

$<HTMLInputElement>('fileInput').onchange = (e) => {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (f) { panels.close(); importBook(() => parseFile(f)) }
}

// Перетаскивание файла в окно.
let dragDepth = 0
const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files')
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('dropOverlay').hidden = false } })
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true } })
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault() })
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth = 0
  $('dropOverlay').hidden = true
  const f = e.dataTransfer!.files[0]
  if (f) { panels.close(); importBook(() => parseFile(f)) }
})

// ---------- Навигация ----------

function goTo(p: Position, o: { flash?: boolean } = {}): void {
  selbar.hide()
  if (speech.active) speech.jump(p)
  reader.showChapter(p.ch, { s: p.s })
  if (o.flash) {
    const el = reader.sentenceEl(p.s)
    if (el) reader.flash(el)
  }
  $('content').focus({ preventScroll: true })
}

reader.onChapter = (ch) => {
  $('chapterTitle').textContent = book.chapters[ch]?.title ?? ''
  ruler.apply()
  if (panels.current === 'toc') panels.render()
}

let saveTimer = 0
reader.onPosition = () => {
  updateProgress()
  ruler.schedule()
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(savePosition, 400)
}

function savePosition(): void {
  if (!book || reader.book !== book) return
  const p = position()
  local.set(`pos:${book.id}`, { ...p, pct: bookPercent(p) })
}
window.addEventListener('pagehide', savePosition)
document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition() })

function bookPercent(p: Position): number {
  const total = book.chapters.reduce((a, c) => a + c.words, 0) || 1
  const before = book.chapters.slice(0, p.ch).reduce((a, c) => a + c.words, 0)
  const cd = reader.data(p.ch)
  const w = cd.sents[p.s]?.w0 ?? 0
  return ((before + (w / Math.max(1, cd.words.length)) * book.chapters[p.ch].words) / total) * 100
}

function updateProgress(): void {
  if (!book) return
  const p = position()
  const cd = reader.data(p.ch)
  const w = cd.sents[p.s]?.w0 ?? 0
  const chPct = (w / Math.max(1, cd.words.length)) * 100
  const bPct = bookPercent(p)
  const set = (id: string, pct: number, text: string) => {
    const el = $(id)
    ;(el.firstElementChild as HTMLElement).style.width = `${pct}%`
    el.setAttribute('aria-valuenow', String(Math.round(pct)))
    el.setAttribute('aria-valuetext', text)
  }
  set('chProgress', chPct, `Глава прочитана на ${Math.round(chPct)}%`)
  set('bookProgress', bPct, `Книга прочитана на ${Math.round(bPct)}%`)
  // Оценка оставшегося времени: при чтении вслух — по темпу голоса.
  const wpm = speech.active ? 150 * settings.s.speechRate * settings.s.playbackRate : 180
  const left = (cd.words.length - w) / wpm
  $('posLabel').textContent = `Глава ${p.ch + 1} из ${book.chapters.length} · ${Math.round(chPct)}% · до конца главы ${formatMinutes(left)} · книга ${Math.round(bPct)}%`
}

// ---------- Плеер ----------

const SPEEDS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.5, 4]

function changeSpeed(dir: 1 | -1): void {
  const cur = settings.s.playbackRate
  const next = dir > 0 ? SPEEDS.find((x) => x > cur + 0.001) ?? 4 : [...SPEEDS].reverse().find((x) => x < cur - 0.001) ?? 0.5
  settings.set({ playbackRate: next })
}

const fmtRate = (r: number) => `${+r.toFixed(2)}×`.replace('.', ',')

function updateStatus(): void {
  const st = speech.state
  const s = settings.s
  const voice = s.engine === 'vosk' ? VOSK_VOICES[s.voskVoice]?.name : (Speech.systemVoices().find((v) => v.voiceURI === s.systemVoice) ?? Speech.systemVoices()[0])?.name ?? 'Системный голос'
  $('ttsStatus').textContent = st === 'playing' ? `Читает ${voice}` : st === 'paused' ? 'Пауза · пробел — продолжить' : st === 'loading' ? 'Готовлю озвучку…' : 'Пробел — читать вслух'
}

function onTtsState(st: TtsState): void {
  const b = $('ttsPlay')
  const busy = st === 'playing' || st === 'loading'
  b.innerHTML = icon(busy ? 'pause' : 'play')
  b.setAttribute('aria-label', busy ? 'Пауза' : st === 'paused' ? 'Продолжить чтение' : 'Читать вслух')
  document.body.dataset.tts = st
  if (st === 'idle') reader.markTts(null)
  if (st !== 'loading') $('loadBar').hidden = true
  updateStatus()
  updateProgress()
  ruler.schedule()
}

$('ttsPlay').onclick = () => speech.toggle(position())
$('ttsStop').onclick = () => speech.stop()
$('ttsPrev').onclick = () => stepSentence(-1)
$('ttsNext').onclick = () => stepSentence(1)
$('speedDown').onclick = () => changeSpeed(-1)
$('speedUp').onclick = () => changeSpeed(1)
$('voicePreview').onclick = () => speech.previewVoice(SAMPLE_PHRASE)

function stepSentence(dir: 1 | -1): void {
  if (speech.active) { speech.jump(dir); return }
  const p = reader.pos
  const cd = reader.data(p.ch)
  const s = p.s + dir
  if (s >= 0 && s < cd.sents.length) goTo({ ch: p.ch, s }, { flash: true })
  else if (s < 0 && p.ch > 0) goTo({ ch: p.ch - 1, s: reader.data(p.ch - 1).sents.length - 1 }, { flash: true })
  else if (s >= cd.sents.length && p.ch + 1 < book.chapters.length) goTo({ ch: p.ch + 1, s: 0 })
}

const voiceSel = $<HTMLSelectElement>('voiceSelect')
fillVoiceSelect(voiceSel)
if (Speech.systemAvailable()) speechSynthesis.addEventListener?.('voiceschanged', () => { if (settings.s.engine === 'system') fillVoiceSelect(voiceSel) })

settings.on((s, ch) => {
  applySettings(s)
  if (ch.includes('playbackRate')) $('speedValue').textContent = fmtRate(s.playbackRate)
  if (ch.includes('engine')) fillVoiceSelect(voiceSel)
  if (ch.includes('voskVoice') || ch.includes('systemVoice')) { voiceSel.value = s.engine === 'vosk' ? String(s.voskVoice) : s.systemVoice; updateStatus() }
  if (ch.some((k) => k === 'fontSize' || k === 'lineHeight' || k === 'columnWidth' || k === 'letterSpacing' || k === 'wordSpacing' || k === 'font' || k === 'paragraphSpacing')) {
    // После смены вёрстки возвращаемся к тому же предложению.
    const p = position()
    if (p.ch === reader.ch) requestAnimationFrame(() => reader.scrollToSentence(p.s, { instant: true, align: 0.3 }))
  }
  updateProgress()
})
$('speedValue').textContent = fmtRate(settings.s.playbackRate)

// ---------- Режим фокусировки ----------

let hintTimer = 0
function setFocusMode(on: boolean): void {
  const p = position()
  document.body.classList.toggle('focus-mode', on)
  document.querySelector('[data-action="focus"]')?.setAttribute('aria-pressed', String(on))
  if (on) {
    panels.close()
    const hint = $('focusHint')
    hint.classList.add('show')
    clearTimeout(hintTimer)
    hintTimer = window.setTimeout(() => hint.classList.remove('show'), 2500)
    $('content').focus({ preventScroll: true })
  }
  toast(on ? 'Режим фокусировки включён. Esc — выйти' : 'Режим фокусировки выключен')
  requestAnimationFrame(() => reader.scrollToSentence(p.s, { instant: true, align: 0.3 }))
}
const inFocus = () => document.body.classList.contains('focus-mode')

// ---------- Закладки и выделения с клавиатуры ----------

function toggleBookmark(): void {
  const p = position()
  const cd = reader.data(p.ch)
  const text = cd.sents[p.s]?.text ?? ''
  const added = annotations.toggleBookmark(p.ch, p.s, book.chapters[p.ch].title, text.length > 140 ? text.slice(0, 140) + '…' : text)
  toast(added ? 'Закладка добавлена' : 'Закладка снята')
}
document.addEventListener('cr:bookmark', toggleBookmark)

function highlightCurrent(withNote: boolean): void {
  const p = position()
  if (p.ch !== reader.ch) return
  const cd = reader.data(p.ch)
  const st = cd.sents[p.s]
  if (!st || st.w1 === st.w0) return
  const ex = annotations.highlightAt(p.ch, st.w0)
  const h = ex ?? annotations.addHighlight({ ch: p.ch, w0: st.w0, w1: st.w1, color: 'yellow', note: '', text: st.text })
  if (withNote) selbar.editNote(h.id)
  else { toast(ex ? 'Предложение уже выделено' : 'Предложение выделено'); selbar.focusFor(h) }
}

// ---------- Кнопки панели инструментов ----------

for (const b of document.querySelectorAll<HTMLElement>('.tool[data-action]')) {
  b.addEventListener('click', () => runAction(b.dataset.action!, b))
}

function runAction(a: string, opener?: HTMLElement): void {
  switch (a) {
    case 'library': case 'toc': case 'search': case 'marks': case 'settings':
      panels.toggle(a, opener); break
    case 'focus': setFocusMode(!inFocus()); break
    case 'rsvp': startRsvp(); break
    case 'help': helpDialog(); break
  }
}

function startRsvp(): void {
  if (speech.state === 'playing' || speech.state === 'loading') speech.pause()
  panels.close()
  rsvp.start(position())
}
rsvp.onClose = (p) => { if (!speech.active) goTo(p) }

// Ссылки внутри текста: главы, блоки.
reader.el.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-goto-chapter], [data-goto-chunk]')
  if (!t) return
  if (t.dataset.gotoChapter) goTo({ ch: +t.dataset.gotoChapter, s: 0 })
  else reader.showChunk(+t.dataset.gotoChunk!)
})

// ---------- Горячие клавиши ----------

const NATIVE_SPACE = 'button, a, input, select, textarea, summary, [role="button"], [role="tab"], [contenteditable]'
const NATIVE_ARROWS = 'input, select, textarea, [role="tab"], .selbar *'

/** Запасной вариант, если браузер не сообщил e.code (экранные клавиатуры и т.п.). */
function codeFromKey(k: string): string {
  if (/^[a-z]$/i.test(k)) return 'Key' + k.toUpperCase()
  const map: Record<string, string> = {
    ' ': 'Space', '/': 'Slash', '?': 'Slash', '+': 'Equal', '=': 'Equal', '-': 'Minus',
    '[': 'BracketLeft', ']': 'BracketRight', Escape: 'Escape', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  }
  return map[k] ?? ''
}

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return
  const t = e.target as HTMLElement
  const code = e.code || codeFromKey(e.key)

  if (rsvp.open) {
    if (code === 'Escape') { e.preventDefault(); rsvp.close() }
    else if (code === 'Space' && !t.matches?.(NATIVE_SPACE)) { e.preventDefault(); rsvp.toggle() }
    else if ((code === 'ArrowLeft' || code === 'ArrowRight') && !t.matches?.('input')) { e.preventDefault(); rsvp.step(code === 'ArrowLeft' ? -1 : 1) }
    else if (code === 'Equal' || code === 'NumpadAdd') { e.preventDefault(); rsvp.speed(25) }
    else if (code === 'Minus' || code === 'NumpadSubtract') { e.preventDefault(); rsvp.speed(-25) }
    return
  }

  if (code === 'Escape') {
    if (selbar.visible) { selbar.hide(); reader.el.focus({ preventScroll: true }); return }
    if (panels.current) { e.preventDefault(); panels.close(); return }
    if (inFocus()) { e.preventDefault(); setFocusMode(false); return }
    return
  }
  if ((e.ctrlKey || e.metaKey) && code === 'KeyF' && !e.shiftKey && !e.altKey) { e.preventDefault(); panels.open('search'); return }
  if (isTypingTarget(t)) return
  if (e.ctrlKey || e.metaKey || e.altKey) return

  switch (code) {
    case 'Space':
      if (t.matches?.(NATIVE_SPACE)) return
      e.preventDefault()
      speech.toggle(position())
      return
    case 'ArrowLeft': case 'ArrowRight':
      if (!speech.active || t.matches?.(NATIVE_ARROWS)) return
      e.preventDefault()
      speech.jump(code === 'ArrowLeft' ? -1 : 1)
      return
    case 'Equal': case 'NumpadAdd': e.preventDefault(); changeSpeed(1); return
    case 'Minus': case 'NumpadSubtract': e.preventDefault(); changeSpeed(-1); return
  }
  if (e.repeat) return
  const handled = (() => {
    switch (code) {
      case 'KeyF': setFocusMode(!inFocus()); return true
      case 'KeyT': panels.toggle('toc'); return true
      case 'Slash': if (e.shiftKey) helpDialog(); else panels.open('search'); return true
      case 'KeyS': panels.toggle('settings'); return true
      case 'KeyM': panels.toggle('marks'); return true
      case 'KeyL': panels.toggle('library'); return true
      case 'KeyB': toggleBookmark(); return true
      case 'KeyH': highlightCurrent(false); return true
      case 'KeyN': highlightCurrent(true); return true
      case 'KeyR': startRsvp(); return true
      case 'KeyG': {
        const order = ['off', 'line', 'paragraph'] as const
        const next = order[(order.indexOf(settings.s.ruler) + 1) % 3]
        settings.set({ ruler: next })
        toast(next === 'off' ? 'Линейка выключена' : next === 'line' ? 'Линейка: строка' : 'Линейка: абзац')
        return true
      }
      case 'KeyJ': if (!settings.s.chunking) { toast('Включите разбивку на блоки в настройках (S)'); return true } reader.showChunk(reader.chunk + 1); return true
      case 'KeyK': if (!settings.s.chunking) return false; reader.showChunk(reader.chunk - 1); return true
      case 'BracketLeft': if (reader.ch > 0) goTo({ ch: reader.ch - 1, s: 0 }); return true
      case 'BracketRight': if (reader.ch + 1 < book.chapters.length) goTo({ ch: reader.ch + 1, s: 0 }); return true
    }
    return false
  })()
  if (handled) e.preventDefault()
})

// ---------- Вёрстка ----------

new ResizeObserver(([e]) => {
  const h = Math.round(e.target.getBoundingClientRect().height)
  document.documentElement.style.setProperty('--topbar-h', `${h}px`)
  document.documentElement.style.scrollPaddingTop = `${h + 24}px`
}).observe($('topbar'))

// ---------- Запуск ----------

async function boot(): Promise<void> {
  const last = local.get<string>('lastBook', 'demo')
  try {
    await openBookById(last)
  } catch {
    await openBook(demoBook(), true)
  }
  updateStatus()
}
boot()

// ---------- PWA ----------

// Открытие файла из системы, если приложение установлено (file_handlers в манифесте).
interface LaunchParams { files: FileSystemFileHandle[] }
const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: LaunchParams) => void): void } }).launchQueue
lq?.setConsumer(async (p) => {
  const h = p.files[0]
  if (h) { const f = await h.getFile(); importBook(() => parseFile(f)) }
})

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    // Первая установка: SW добавит заголовки изоляции, нужные многопоточному синтезу. Перезагружаемся один раз.
    if (!crossOriginIsolated && !navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (sessionStorage.getItem('cr:coi') || speech.active) return
        sessionStorage.setItem('cr:coi', '1')
        savePosition()
        location.reload()
      }, { once: true })
    }
    reg.addEventListener('updatefound', () => {
      const w = reg.installing
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) toast('Доступна новая версия — она загрузится при следующем открытии')
      })
    })
  }).catch((e) => console.warn('Service worker:', e))
}

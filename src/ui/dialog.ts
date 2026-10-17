import { $, esc } from './dom'

let busy: Promise<unknown> = Promise.resolve()

/**
 * Показывает модальный диалог. Кнопки с data-value закрывают его с этим значением.
 * Возвращает значение или null (Esc / закрытие).
 */
export function showDialog<T = string>(html: string, setup?: (d: HTMLDialogElement, close: (v: T | null) => void) => void): Promise<T | null> {
  const run = () => new Promise<T | null>((resolve) => {
    const d = $<HTMLDialogElement>('dialog')
    const opener = document.activeElement as HTMLElement | null
    d.innerHTML = `<div class="dlg-inner">${html}</div>`
    let done = false
    const close = (v: T | null) => {
      if (done) return
      done = true
      d.close()
      d.innerHTML = ''
      opener?.focus?.({ preventScroll: true })
      resolve(v)
    }
    d.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
      if (b) close(b.dataset.value as T)
      else if (e.target === d) close(null) // клик по подложке
    }
    d.oncancel = (e) => { e.preventDefault(); close(null) }
    setup?.(d, close)
    d.showModal()
    const auto = d.querySelector<HTMLElement>('[autofocus]') ?? d.querySelector<HTMLElement>('.primary')
    // Фокус на кнопке внизу не должен прокручивать длинный диалог (справку) к концу.
    auto?.focus({ preventScroll: true })
    d.scrollTop = 0
  })
  const p = busy.then(run, run)
  busy = p.catch(() => {})
  return p
}

export async function confirmDialog(title: string, text: string, ok = 'Да', danger = false): Promise<boolean> {
  const r = await showDialog(`
    <h2 id="dlgTitle">${esc(title)}</h2>
    <p>${esc(text)}</p>
    <div class="actions">
      <button type="button" class="btn" data-value="no">Отмена</button>
      <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-value="yes" autofocus>${esc(ok)}</button>
    </div>`)
  return r === 'yes'
}

/** Согласие на скачивание голосовой модели. */
export async function askModelDialog(systemAvailable: boolean): Promise<boolean | null> {
  const r = await showDialog(`
    <h2 id="dlgTitle">Скачать нейросетевые голоса?</h2>
    <p>Для естественного чтения вслух нужна голосовая модель Vosk TTS — около <strong>285 МБ</strong>. Она скачивается один раз с Hugging Face и сохраняется в браузере. После этого озвучка работает <strong>без интернета</strong>, а текст книги никуда не отправляется.</p>
    <p class="hint">Совет: начинайте загрузку по Wi‑Fi. Первая загрузка может занять несколько минут.</p>
    <div class="actions">
      ${systemAvailable ? '<button type="button" class="btn" data-value="system">Пока системный голос</button>' : '<button type="button" class="btn" data-value="cancel">Отмена</button>'}
      <button type="button" class="btn primary" data-value="vosk" autofocus>Скачать модель</button>
    </div>`)
  if (r === 'vosk') return true
  if (r === 'system') return false
  return null
}

export async function noteDialog(quote: string, note: string): Promise<string | null> {
  let text = note
  const r = await showDialog(`
    <h2 id="dlgTitle">Заметка</h2>
    <blockquote>${esc(quote.length > 300 ? quote.slice(0, 300) + '…' : quote)}</blockquote>
    <label for="noteText" class="sr-only">Текст заметки</label>
    <textarea id="noteText" autofocus placeholder="Ваша мысль, вопрос или пересказ своими словами…">${esc(note)}</textarea>
    <p class="hint"><kbd>Ctrl</kbd> + <kbd>Enter</kbd> — сохранить</p>
    <div class="actions">
      <button type="button" class="btn" data-value="cancel">Отмена</button>
      <button type="button" class="btn primary" data-value="save">Сохранить</button>
    </div>`, (d, close) => {
    const ta = d.querySelector('textarea')!
    ta.oninput = () => { text = ta.value }
    ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { text = ta.value; close('save') } }
  })
  return r === 'save' ? text.trim() : null
}

export async function pasteDialog(): Promise<{ title: string; text: string } | null> {
  let title = '', text = ''
  const r = await showDialog(`
    <h2 id="dlgTitle">Вставить текст</h2>
    <label class="field select"><span class="label">Название</span><input id="pasteTitle" class="text-input" type="text" placeholder="Без названия" /></label>
    <label for="pasteText" class="label">Текст</label>
    <textarea id="pasteText" autofocus placeholder="Вставьте текст статьи или книги…"></textarea>
    <div class="actions">
      <button type="button" class="btn" data-value="cancel">Отмена</button>
      <button type="button" class="btn primary" data-value="ok">Открыть</button>
    </div>`, (d) => {
    const t = d.querySelector<HTMLInputElement>('#pasteTitle')!, ta = d.querySelector('textarea')!
    t.oninput = () => { title = t.value }
    ta.oninput = () => { text = ta.value }
  })
  if (r !== 'ok' || !text.trim()) return null
  return { title: title.trim() || text.trim().split('\n')[0].slice(0, 60), text }
}

const KEYS: [string, string][] = [
  ['<kbd>Пробел</kbd>', 'Пауза / продолжить чтение вслух'],
  ['<kbd>←</kbd> <kbd>→</kbd>', 'Предложение назад / вперёд (при чтении вслух)'],
  ['<kbd>+</kbd> <kbd>−</kbd>', 'Скорость чтения вслух'],
  ['<kbd>Esc</kbd>', 'Закрыть панель, выйти из режима фокусировки или RSVP'],
  ['<kbd>F</kbd>', 'Режим фокусировки'],
  ['<kbd>T</kbd>', 'Оглавление'],
  ['<kbd>/</kbd> или <kbd>Ctrl</kbd>+<kbd>F</kbd>', 'Поиск по книге'],
  ['<kbd>S</kbd>', 'Оформление и настройки'],
  ['<kbd>M</kbd>', 'Закладки и заметки'],
  ['<kbd>B</kbd>', 'Поставить / снять закладку на текущем предложении'],
  ['<kbd>H</kbd>', 'Выделить текущее предложение'],
  ['<kbd>N</kbd>', 'Заметка к текущему предложению'],
  ['<kbd>G</kbd>', 'Линейка: выкл → строка → абзац'],
  ['<kbd>R</kbd>', 'Быстрое чтение RSVP'],
  ['<kbd>J</kbd> <kbd>K</kbd>', 'Следующий / предыдущий блок (в режиме блоков)'],
  ['<kbd>[</kbd> <kbd>]</kbd>', 'Предыдущая / следующая глава'],
  ['<kbd>L</kbd>', 'Книги: открыть файл, библиотека'],
  ['<kbd>A</kbd>', 'Показать или скрыть плеер внизу'],
  ['<kbd>?</kbd>', 'Эта справка'],
]

export function helpDialog(): Promise<unknown> {
  return showDialog(`
    <h2 id="dlgTitle">Горячие клавиши</h2>
    <p class="hint">Клавиши работают в любой раскладке. Tab переходит между кнопками, Enter или пробел нажимает кнопку.</p>
    <table class="keys"><tbody>${KEYS.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</tbody></table>
    <div class="actions"><button type="button" class="btn primary" data-value="ok">Понятно</button></div>`)
}

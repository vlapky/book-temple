import { settings, THEMES, FONTS, DEFAULTS, effectiveColors, contrastRatio, type Settings } from '../settings'
import { annotations, type Highlight } from '../annotations'
import type { Reader } from '../reader'
import type { Speech } from '../tts/engine'
import type { BookMeta, Position } from '../book/types'
import { VOSK_VOICES, GENDER_LABEL, SAMPLE_PHRASE } from '../tts/voices'
import { listBooks, deleteBook, local } from '../storage'
import { $, esc, toast, plural } from './dom'
import { hydrateIcons } from './icons'
import { confirmDialog, noteDialog, pasteDialog } from './dialog'
import { FN_RE } from '../text/segment'

export interface AppApi {
  reader: Reader
  speech: Speech
  goTo(p: Position, o?: { flash?: boolean }): void
  pickFile(): void
  openText(title: string, text: string): void
  openBook(id: string): void
  currentBookId(): string
  /** Текущая позиция чтения (TTS или под линией взгляда). */
  position(): Position
}

type PanelName = 'settings' | 'toc' | 'search' | 'marks' | 'library'
const TITLES: Record<PanelName, string> = {
  settings: 'Оформление и настройки',
  toc: 'Оглавление',
  search: 'Поиск по книге',
  marks: 'Закладки и заметки',
  library: 'Книги',
}

const isNarrow = () => innerWidth < 720

export class Panels {
  current: PanelName | null = null
  private opener: HTMLElement | null = null
  private el = $('panel')
  private body = $('panelBody')
  private marksTab: 'bookmarks' | 'notes' = 'bookmarks'
  private searchQuery = ''
  private fmts = new Map<string, (v: number) => string>()

  private app: AppApi

  constructor(app: AppApi) {
    this.app = app
    $('panelClose').onclick = () => this.close()
    this.el.setAttribute('role', 'complementary')
    annotations.on(() => { if (this.current === 'marks') this.render() })
    settings.on((_, ch) => {
      if (this.current !== 'settings') return
      if (ch.includes('engine') || ch.includes('chunking') || ch.includes('ruler')) this.render()
      else this.syncControls()
    })
  }

  toggle(name: PanelName, opener?: HTMLElement): void {
    if (this.current === name) this.close()
    else this.open(name, opener)
  }

  open(name: PanelName, opener?: HTMLElement): void {
    this.opener = opener ?? (document.activeElement as HTMLElement | null)
    this.current = name
    $('panelTitle').textContent = TITLES[name]
    this.el.hidden = false
    document.body.classList.add('panel-open')
    this.updateToolState()
    this.render()
    const first = name === 'search' ? this.body.querySelector<HTMLElement>('input') : this.body.querySelector<HTMLElement>('[aria-current="true"], input, button, select')
    ;(first ?? $('panelClose')).focus({ preventScroll: true })
    // Прокручиваем только список панели: scrollIntoView сдвинул бы и страницу с книгой.
    const cur = name === 'toc' ? this.body.querySelector<HTMLElement>('[aria-current="true"]') : null
    if (cur) this.body.scrollTop = Math.max(0, cur.offsetTop - this.body.clientHeight / 2)
  }

  close(): void {
    if (!this.current) return
    this.current = null
    this.el.hidden = true
    document.body.classList.remove('panel-open')
    this.body.innerHTML = ''
    this.updateToolState()
    const back = this.opener && document.contains(this.opener) ? this.opener : $('content')
    back.focus({ preventScroll: true })
  }

  /** Закрыть панель после перехода, если она перекрывает текст. */
  private afterJump(): void { if (isNarrow()) this.close() }

  private updateToolState(): void {
    document.getElementById('moreBtn')?.classList.toggle('is-active', this.current === 'settings')
    for (const b of document.querySelectorAll<HTMLElement>('.tool[data-action]')) {
      const a = b.dataset.action!
      if (a in TITLES) {
        b.setAttribute('aria-controls', 'panel')
        b.setAttribute('aria-expanded', String(this.current === a))
      }
    }
  }

  render(): void {
    if (!this.current) return
    const scroll = this.body.scrollTop
    this.body.innerHTML = ''
    this[this.current]()
    hydrateIcons(this.body)
    this.body.scrollTop = scroll
  }

  // ---------- Оформление ----------

  private settings(): void {
    const s = settings.s
    this.fmts.clear()
    const range = (key: keyof Settings, label: string, min: number, max: number, step: number, fmt: (v: number) => string, hint = '') => (this.fmts.set(key, fmt), `
      <div class="field">
        <label for="set-${key}">${label}</label>
        <output for="set-${key}" data-out="${key}">${fmt(s[key] as number)}</output>
        <input type="range" id="set-${key}" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}" aria-valuetext="${esc(fmt(s[key] as number))}" />
        ${hint ? `<p class="hint">${hint}</p>` : ''}
      </div>`)
    const seg = (key: keyof Settings, label: string, opts: [string, string][]) => `
      <fieldset class="field select" style="border:0;padding:0;margin:10px 0">
        <legend class="label" style="padding:0;margin-bottom:6px;font-weight:500">${label}</legend>
        <div class="seg">${opts.map(([v, t]) => `<label><input type="radio" name="set-${key}" data-key="${key}" value="${v}" ${String(s[key]) === v ? 'checked' : ''}/>${t}</label>`).join('')}</div>
      </fieldset>`
    const check = (key: keyof Settings, label: string) => `
      <label class="check"><input type="checkbox" data-key="${key}" ${s[key] ? 'checked' : ''}/>${label}</label>`

    const { bg, fg } = effectiveColors(s)
    const cr = contrastRatio(fg, bg)

    this.body.innerHTML = `
      <section class="group" aria-labelledby="g-text">
        <h3 class="group-title" id="g-text">Шрифт</h3>
        <div class="fonts" role="radiogroup" aria-labelledby="g-text">
          ${(Object.keys(FONTS) as (keyof typeof FONTS)[]).map((f) => `
            <label class="font-card"><input type="radio" name="set-font" data-key="font" value="${f}" ${s.font === f ? 'checked' : ''}/>
              <span class="sample" style="font-family:${esc(FONTS[f].stack)}">${FONTS[f].name}, Аа Бб Жж</span>
              <small>${FONTS[f].note ?? ''}</small></label>`).join('')}
        </div>
        ${range('fontSize', 'Размер шрифта', 14, 40, 1, (v) => `${v} px`)}
        ${range('lineHeight', 'Межстрочный интервал', 1.2, 2.6, 0.05, (v) => v.toFixed(2))}
        ${range('letterSpacing', 'Расстояние между буквами', 0, 0.2, 0.005, (v) => `${(v * 100).toFixed(1)}%`)}
        ${range('wordSpacing', 'Расстояние между словами', 0, 0.8, 0.02, (v) => `${(v * 100).toFixed(0)}%`)}
        ${range('columnWidth', 'Ширина колонки', 30, 100, 1, (v) => `${v} знаков`, 'Удобнее всего 50–75 знаков в строке.')}
        ${range('paragraphSpacing', 'Отступ между абзацами', 0, 2.5, 0.1, (v) => `${v.toFixed(1)} em`)}
        ${seg('align', 'Выравнивание', [['left', 'По левому краю'], ['justify', 'По ширине']])}
      </section>

      <section class="group" aria-labelledby="g-color">
        <h3 class="group-title" id="g-color">Цвет</h3>
        <div class="themes" role="radiogroup" aria-labelledby="g-color">
          ${(Object.keys(THEMES) as (keyof typeof THEMES)[]).map((t) => `
            <label class="theme-card">
              <input type="radio" name="set-theme" data-key="theme" value="${t}" ${s.theme === t ? 'checked' : ''}/>
              <span class="aa" aria-hidden="true" style="background:${THEMES[t].bg};color:${THEMES[t].fg};--sw-rule:${THEMES[t].rule}">Аа</span>${THEMES[t].name}</label>`).join('')}
        </div>
        ${range('contrast', 'Контраст текста', 20, 100, 1, (v) => `${v}%`)}
        <p class="hint">Контрастность: <span class="contrast-badge ${cr >= 7 ? 'ok' : cr >= 4.5 ? 'warn' : 'bad'}" id="crBadge">${cr.toFixed(1)}:1 ${cr >= 7 ? 'AAA' : cr >= 4.5 ? 'AA' : 'низкая'}</span></p>
        <div class="colors" style="margin-top:10px">
          <label class="color-pick"><input type="color" data-key="bgCustom" value="${bg}" aria-label="Цвет фона"/>Фон</label>
          <label class="color-pick"><input type="color" data-key="fgCustom" value="${s.fgCustom || THEMES[s.theme].fg}" aria-label="Цвет текста"/>Текст</label>
          <button type="button" class="btn ghost" data-reset="bgCustom,fgCustom,contrast">Сбросить цвета</button>
        </div>
      </section>

      <section class="group" aria-labelledby="g-tts">
        <h3 class="group-title" id="g-tts">Чтение вслух</h3>
        ${seg('engine', 'Синтезатор', [['vosk', 'Нейросетевой (офлайн)'], ['system', 'Системный']])}
        <div class="field select">
          <label for="set-voice">Голос</label>
          <div style="display:flex;gap:6px"><select id="set-voice" data-voice-select></select>
          <button type="button" class="btn" id="previewBtn" data-icon="speaker">Прослушать</button></div>
        </div>
        ${s.engine === 'vosk' ? check('wholeChapter', 'Озвучивать главу целиком') + '<p class="hint" style="margin-top:-6px">Для телефонов, где голос готовится медленнее, чем звучит. Текущая и три следующие главы озвучиваются заранее; главу можно слушать, когда она готова. Хранятся ещё две прошлые главы. Если снять галочку, вся сохранённая озвучка удалится.</p>' : ''}
        ${range('playbackRate', 'Скорость воспроизведения', 0.5, 4, 0.05, (v) => `${v.toFixed(2).replace(/0$/, '')}×`, 'Ускоряет готовый звук без изменения высоты голоса. Клавиши + и −.')}
        ${range('speechRate', 'Темп речи при синтезе', 0.5, 2, 0.05, (v) => `${v.toFixed(2).replace(/0$/, '')}×`, 'Как быстро диктор произносит слова — звучит естественнее, чем ускорение.')}
        ${s.engine === 'vosk' ? range('expressiveness', 'Выразительность', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, 'Меньше — ровнее и спокойнее, больше — живее интонации.') : ''}
        ${seg('highlight', 'Подсветка', [['both', 'Слово и предложение'], ['word', 'Только слово'], ['sentence', 'Только предложение']])}
        ${check('autoScroll', 'Автопрокрутка за голосом')}
        ${s.engine === 'vosk' ? `
          <div class="field select">
            <label for="set-backend">Вычисления</label>
            <select id="set-backend" data-key="backend">
              <option value="auto" ${s.backend === 'auto' ? 'selected' : ''}>Автоматически (WebGPU, если есть)</option>
              <option value="webgpu" ${s.backend === 'webgpu' ? 'selected' : ''}>Видеокарта (WebGPU)</option>
              <option value="wasm" ${s.backend === 'wasm' ? 'selected' : ''}>Процессор (WASM)</option>
            </select>
            <p class="hint" id="modelStatus">${this.app.speech.vosk.loaded ? `Модель загружена и считается ${this.app.speech.vosk.backend === 'webgpu' ? 'на видеокарте' : 'на процессоре'}${crossOriginIsolated ? ' в несколько потоков' : ''}.` : 'Модель ещё не загружена.'} Новый режим вычислений включится после перезагрузки страницы.</p>
          </div>
          <div class="btn-row"><button type="button" class="btn danger" id="clearModel" data-icon="trash">Удалить модель из памяти</button></div>` : ''}
      </section>

      <section class="group" aria-labelledby="g-focus">
        <h3 class="group-title" id="g-focus">Концентрация</h3>
        ${seg('ruler', 'Направляющая линейка (G)', [['off', 'Выключена'], ['line', 'Строка'], ['paragraph', 'Абзац']])}
        ${s.ruler !== 'off' ? range('rulerDim', 'Затемнение вокруг', 0.2, 0.9, 0.05, (v) => `${Math.round(v * 100)}%`) : ''}
        ${s.ruler === 'line' ? range('rulerLines', 'Высота окна, строк', 1, 5, 1, (v) => String(v)) : ''}
        ${check('chunking', 'Делить главу на небольшие блоки')}
        ${s.chunking ? range('chunkWords', 'Размер блока', 60, 400, 10, (v) => `≈ ${v} слов`) + check('chunkSingle', 'Показывать по одному блоку (J / K — листать)') : ''}
      </section>

      <section class="group" aria-labelledby="g-rsvp">
        <h3 class="group-title" id="g-rsvp">Режим RSVP</h3>
        ${range('rsvpWpm', 'Скорость', 100, 1000, 25, (v) => `${v} сл/мин`)}
        ${seg('rsvpWords', 'Слов за раз', [['1', '1'], ['2', '2'], ['3', '3']])}
        ${check('rsvpContext', 'Показывать предложение целиком под словом')}
      </section>

      <section class="group" aria-labelledby="g-reset">
        <h3 class="group-title" id="g-reset">Сброс</h3>
        <p class="hint">Настройки сохраняются автоматически на этом устройстве.</p>
        <div class="btn-row">
          <button type="button" class="btn" data-reset="font,fontSize,lineHeight,letterSpacing,wordSpacing,columnWidth,paragraphSpacing,align,theme,contrast,bgCustom,fgCustom">Сбросить оформление</button>
          <button type="button" class="btn" data-reset="*">Сбросить всё</button>
        </div>
      </section>`

    const b = this.body
    b.oninput = (e) => this.onControl(e.target as HTMLInputElement)
    b.onchange = (e) => this.onControl(e.target as HTMLInputElement)
    b.onclick = (e) => {
      const r = (e.target as HTMLElement).closest<HTMLElement>('[data-reset]')
      if (r) {
        const keys = r.dataset.reset === '*' ? (Object.keys(DEFAULTS) as (keyof Settings)[]) : (r.dataset.reset!.split(',') as (keyof Settings)[])
        settings.reset(keys)
        this.render()
        toast('Настройки сброшены')
      }
    }
    b.querySelector('#set-contrast')?.closest('.field')?.classList.add('keep-contrast')
    fillVoiceSelect(b.querySelector('[data-voice-select]')!)
    b.querySelector<HTMLButtonElement>('#previewBtn')!.onclick = () => this.app.speech.previewVoice(SAMPLE_PHRASE)
    const clear = b.querySelector<HTMLButtonElement>('#clearModel')
    if (clear) clear.onclick = async () => {
      if (!(await confirmDialog('Удалить голосовую модель?', 'Файлы модели (~285 МБ) будут удалены из памяти браузера. Для нейросетевой озвучки их придётся скачать заново.', 'Удалить', true))) return
      try {
        await new Promise<void>((res, rej) => {
          const r = indexedDB.deleteDatabase('vosk-tts-web')
          r.onsuccess = () => res(); r.onerror = () => rej(r.error); r.onblocked = () => res()
        })
        localStorage.removeItem('cr:modelConsent')
        toast('Модель удалена. Изменения вступят в силу после перезагрузки.')
      } catch (e) { toast('Не удалось удалить модель: ' + (e as Error).message, 'error') }
    }
  }

  private onControl(t: HTMLInputElement | HTMLSelectElement): void {
    const key = t.dataset.key as keyof Settings | undefined
    if (!key) return
    const def = DEFAULTS[key]
    let v: unknown
    if (t instanceof HTMLInputElement && t.type === 'checkbox') v = t.checked
    else if (typeof def === 'number') v = +t.value
    else v = t.value
    if (t instanceof HTMLInputElement && t.type === 'radio' && !t.checked) return
    settings.set({ [key]: v } as Partial<Settings>)
  }

  /** Обновить значения контролов без перерисовки (чтобы не терять фокус). */
  private syncControls(): void {
    const s = settings.s
    for (const el of this.body.querySelectorAll<HTMLInputElement>('[data-key]')) {
      const key = el.dataset.key as keyof Settings
      const v = s[key]
      if (el.type === 'checkbox') el.checked = !!v
      else if (el.type === 'radio') el.checked = String(v) === el.value
      else if (el.type === 'color') el.value = key === 'bgCustom' ? effectiveColors(s).bg : s.fgCustom || THEMES[s.theme].fg
      else if (document.activeElement !== el) el.value = String(v)
      if (el.type === 'range') {
        const out = this.body.querySelector(`[data-out="${key}"]`)
        const txt = this.fmts.get(key)?.(+el.value) ?? el.value
        if (out) out.textContent = txt
        el.setAttribute('aria-valuetext', txt)
      }
    }
    const { bg, fg } = effectiveColors(s)
    const cr = contrastRatio(fg, bg)
    const badge = this.body.querySelector('#crBadge')
    if (badge) {
      badge.className = `contrast-badge ${cr >= 7 ? 'ok' : cr >= 4.5 ? 'warn' : 'bad'}`
      badge.textContent = `${cr.toFixed(1)}:1 ${cr >= 7 ? 'AAA' : cr >= 4.5 ? 'AA' : 'низкая'}`
    }
    const vs = this.body.querySelector<HTMLSelectElement>('[data-voice-select]')
    if (vs) vs.value = s.engine === 'vosk' ? String(s.voskVoice) : s.systemVoice
  }

  // ---------- Оглавление ----------

  private toc(): void {
    const r = this.app.reader
    const book = r.book
    const cur = r.ch
    const total = book.chapters.reduce((a, c) => a + c.words, 0)
    this.body.innerHTML = `
      <p class="hint" style="margin:0 0 10px">${book.author ? `${esc(book.author)}, «${esc(book.title)}». ` : ''}${book.chapters.length} ${plural(book.chapters.length, 'глава', 'главы', 'глав')}, около ${Math.max(1, Math.round(total / 180))} мин чтения.</p>
      <nav aria-label="Главы"><ol class="list" style="list-style:none">
        ${book.chapters.map((c, i) => {
          const pct = i < cur ? 100 : i > cur ? 0 : Math.round((r.pos.s / Math.max(1, r.data(i).sents.length)) * 100)
          return `<li><button type="button" class="toc-item" data-ch="${i}" ${i === cur ? 'aria-current="true"' : ''}>
            <span class="num">${i + 1}</span><span>${esc(c.title)}</span></button>
            ${pct > 0 ? `<div class="toc-progress" aria-hidden="true"><span style="width:${pct}%"></span></div>` : ''}</li>`
        }).join('')}
      </ol></nav>`
    this.body.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ch]')
      if (!b) return
      this.app.goTo({ ch: +b.dataset.ch!, s: 0 })
      this.close()
    }
  }

  // ---------- Поиск ----------

  private search(): void {
    this.body.innerHTML = `
      <div class="search-box" role="search">
        <label for="searchInput" class="sr-only">Искать в книге</label>
        <input id="searchInput" class="text-input" type="search" placeholder="Слово или фраза…" autocomplete="off" value="${esc(this.searchQuery)}" />
      </div>
      <p class="hint" id="searchCount" role="status" aria-live="polite"></p>
      <ol class="list" id="searchResults"></ol>`
    const input = this.body.querySelector<HTMLInputElement>('#searchInput')!
    let timer = 0
    input.oninput = () => {
      clearTimeout(timer)
      timer = window.setTimeout(() => { this.searchQuery = input.value; this.runSearch() }, 180)
    }
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.body.querySelector<HTMLElement>('#searchResults button')?.click() }
      if (e.key === 'ArrowDown') { e.preventDefault(); this.body.querySelector<HTMLElement>('#searchResults button')?.focus() }
    }
    this.body.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-hit]')
      if (!b) return
      const [ch, bl, occ] = b.dataset.hit!.split(':').map(Number)
      this.jumpToHit(ch, bl, occ)
    }
    this.body.onkeydown = (e) => {
      const t = e.target as HTMLElement
      if (!t.matches('[data-hit]') || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
      e.preventDefault()
      const all = Array.from(this.body.querySelectorAll<HTMLElement>('[data-hit]'))
      const i = all.indexOf(t) + (e.key === 'ArrowDown' ? 1 : -1)
      if (i < 0) input.focus(); else all[Math.min(i, all.length - 1)].focus()
    }
    if (this.searchQuery) this.runSearch()
  }

  private runSearch(): void {
    const q = norm(this.searchQuery.trim())
    const out = this.body.querySelector('#searchResults')
    const count = this.body.querySelector('#searchCount')
    if (!out || !count) return
    if (q.length < 2) { out.innerHTML = ''; count.textContent = q ? 'Введите хотя бы два символа' : ''; return }
    const book = this.app.reader.book
    const hits: string[] = []
    let n = 0
    book.chapters.forEach((c, ci) => {
      c.blocks.forEach((b, bi) => {
        const text = b.text.replace(FN_RE, '')
        const t = norm(text)
        let from = 0, occ = 0
        for (let i; (i = t.indexOf(q, from)) >= 0; from = i + q.length, occ++) {
          n++
          if (hits.length >= 200) continue
          const a = Math.max(0, i - 50), z = Math.min(text.length, i + q.length + 70)
          const snip = (a > 0 ? '…' : '') + esc(text.slice(a, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length, z)) + (z < text.length ? '…' : '')
          hits.push(`<li><button type="button" class="item-main search-hit" data-hit="${ci}:${bi}:${occ}" style="margin:6px -8px">
            <span class="item-sub">Глава ${ci + 1}, «${esc(c.title)}»</span><span class="item-quote">${snip}</span></button></li>`)
        }
      })
    })
    count.textContent = n ? `Найдено: ${n}${n > 200 ? ' (показаны первые 200)' : ''}` : 'Ничего не найдено'
    out.innerHTML = hits.join('')
  }

  private jumpToHit(ch: number, block: number, occ: number): void {
    const cd = this.app.reader.data(ch)
    const b = cd.blocks[block]
    const q = norm(this.searchQuery.trim())
    let s = b.s0, seen = 0
    for (let i = b.s0; i < b.s1; i++) {
      const t = norm(cd.sents[i].text)
      let from = 0, k = 0
      for (let j; (j = t.indexOf(q, from)) >= 0; from = j + q.length) k++
      if (seen + k > occ) { s = i; break }
      seen += k
      s = i
    }
    this.app.goTo({ ch, s }, { flash: true })
    this.afterJump()
  }

  // ---------- Закладки и заметки ----------

  private marks(): void {
    const tab = this.marksTab
    const book = this.app.reader.book
    const bms = annotations.bookmarks
    const hls = annotations.highlights
    const date = (t: number) => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
    this.body.innerHTML = `
      <div class="tabs" role="tablist" aria-label="Тип">
        <button type="button" role="tab" id="tab-bm" aria-controls="tabpanel" aria-selected="${tab === 'bookmarks'}" data-tab="bookmarks">Закладки (${bms.length})</button>
        <button type="button" role="tab" id="tab-notes" aria-controls="tabpanel" aria-selected="${tab === 'notes'}" data-tab="notes">Выделения (${hls.length})</button>
      </div>
      <div id="tabpanel" role="tabpanel" aria-labelledby="${tab === 'bookmarks' ? 'tab-bm' : 'tab-notes'}">
      ${tab === 'bookmarks' ? `
        <div class="btn-row"><button type="button" class="btn primary" data-act="add-bm" data-icon="bookmark">Закладка здесь (B)</button></div>
        ${bms.length ? `<ul class="list">${bms.map((b) => `
          <li class="item">
            <button type="button" class="item-main" data-go="${b.ch}:${b.s}">
              <span class="item-title">${esc(book.chapters[b.ch]?.title ?? b.label)}</span>
              <span class="item-quote">${esc(b.snippet)}</span>
              <span class="item-sub">${date(b.created)}</span>
            </button>
            <button type="button" class="pbtn small" data-del-bm="${b.id}" data-icon="trash" aria-label="Удалить закладку"></button>
          </li>`).join('')}</ul>` : '<p class="empty">Закладок пока нет. Нажмите B, чтобы отметить место, где остановились.</p>'}
      ` : `
        ${hls.length ? `<div class="btn-row"><button type="button" class="btn" data-act="export" data-icon="download">Экспорт в Markdown</button></div>
        <ul class="list">${hls.map((h) => `
          <li class="item">
            <div style="flex:1;min-width:0">
              <button type="button" class="item-main" data-go-w="${h.ch}:${h.w0}">
                <span class="item-sub"><span class="swatch ${h.color}" aria-hidden="true"></span>${esc(book.chapters[h.ch]?.title ?? '')}, ${date(h.created)}</span>
                <span class="item-quote">${esc(h.text.length > 240 ? h.text.slice(0, 240) + '…' : h.text)}</span>
              </button>
              ${h.note ? `<div class="item-note">${esc(h.note)}</div>` : ''}
            </div>
            <div style="display:grid;gap:2px">
              <button type="button" class="pbtn small" data-edit-hl="${h.id}" data-icon="note" aria-label="${h.note ? 'Изменить заметку' : 'Добавить заметку'}"></button>
              <button type="button" class="pbtn small" data-del-hl="${h.id}" data-icon="trash" aria-label="Удалить выделение"></button>
            </div>
          </li>`).join('')}</ul>` : '<p class="empty">Выделите текст мышью или нажмите H, чтобы отметить текущее предложение.</p>'}
      `}</div>`
    this.body.onclick = async (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('button')
      if (!t) return
      const d = t.dataset
      if (d.tab) { this.marksTab = d.tab as 'bookmarks' | 'notes'; this.render(); this.body.querySelector<HTMLElement>(`[data-tab="${d.tab}"]`)?.focus() }
      else if (d.go) { const [ch, s] = d.go.split(':').map(Number); this.app.goTo({ ch, s }, { flash: true }); this.afterJump() }
      else if (d.goW) {
        const [ch, w] = d.goW.split(':').map(Number)
        this.app.goTo({ ch, s: this.app.reader.data(ch).words[w]?.s ?? 0 }, { flash: true })
        this.afterJump()
      }
      else if (d.delBm) { annotations.removeBookmark(d.delBm); toast('Закладка удалена') }
      else if (d.delHl) { if (await confirmDialog('Удалить выделение?', 'Выделение и заметка к нему будут удалены.', 'Удалить', true)) annotations.removeHighlight(d.delHl) }
      else if (d.editHl) {
        const h = annotations.highlights.find((x) => x.id === d.editHl)
        if (!h) return
        const note = await noteDialog(h.text, h.note)
        if (note != null) annotations.updateHighlight(h.id, { note })
      }
      else if (d.act === 'add-bm') document.dispatchEvent(new CustomEvent('cr:bookmark'))
      else if (d.act === 'export') exportNotes(book.title, book.chapters.map((c) => c.title), annotations.highlights)
    }
  }

  // ---------- Библиотека ----------

  private library(): void {
    this.body.innerHTML = `
      <div class="btn-row" style="margin:12px 0">
        <button type="button" class="btn primary" data-act="file" data-icon="open">Открыть файл</button>
        <button type="button" class="btn" data-act="paste" data-icon="text">Вставить текст</button>
      </div>
      <p class="lib-drop">Можно перетащить файл прямо в окно. Подходят FB2, EPUB, TXT, Markdown и HTML.</p>
      <h3 class="group-title" style="margin-top:24px">Мои книги</h3>
      <ul class="list" id="libList"><li class="empty">Загрузка…</li></ul>`
    listBooks().then((books) => this.renderLibrary(books)).catch(() => {
      const l = this.body.querySelector('#libList')
      if (l) l.innerHTML = '<li class="empty">Библиотека недоступна (браузер запрещает хранилище)</li>'
    })
    this.body.onclick = async (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('button')
      if (!t) return
      const d = t.dataset
      if (d.act === 'file') this.app.pickFile()
      else if (d.act === 'paste') {
        const r = await pasteDialog()
        if (r) { this.close(); this.app.openText(r.title, r.text) }
      }
      else if (d.open) { this.close(); this.app.openBook(d.open) }
      else if (d.del) {
        if (!(await confirmDialog('Удалить книгу?', `«${d.title}» будет удалена из библиотеки вместе с закладками и заметками.`, 'Удалить', true))) return
        await deleteBook(d.del)
        if (d.del === this.app.currentBookId()) this.app.openBook('demo')
        this.render()
      }
    }
  }

  private renderLibrary(books: BookMeta[]): void {
    const l = this.body.querySelector('#libList')
    if (!l) return
    const cur = this.app.currentBookId()
    l.innerHTML = books.length ? books.map((b) => {
      const pct = Math.round(local.get<{ pct?: number }>(`pos:${b.id}`, {}).pct ?? 0)
      return `<li class="item" ${b.id === cur ? 'aria-current="true"' : ''}>
        <button type="button" class="item-main" data-open="${esc(b.id)}">
          <span class="item-title">${esc(b.title)}</span>
          <span class="item-sub">${b.author ? esc(b.author) + '. ' : ''}Прочитано ${pct}%, всего около ${Math.max(1, Math.round(b.words / 180))} мин</span>
        </button>
        ${b.id === 'demo' ? '' : `<button type="button" class="pbtn small" data-del="${esc(b.id)}" data-title="${esc(b.title)}" data-icon="trash" aria-label="Удалить книгу «${esc(b.title)}»"></button>`}
      </li>`
    }).join('') : '<li class="empty">Здесь появятся открытые книги</li>'
    hydrateIcons(l)
  }
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е')

/** Заполняет список голосов текущего синтезатора. */
export function fillVoiceSelect(sel: HTMLSelectElement): void {
  const s = settings.s
  sel.innerHTML = ''
  if (s.engine === 'vosk') {
    for (const g of ['f', 'm', 'x'] as const) {
      const og = document.createElement('optgroup')
      og.label = GENDER_LABEL[g]
      for (const v of VOSK_VOICES.filter((x) => x.g === g)) og.append(new Option(v.name, String(v.id)))
      sel.append(og)
    }
    sel.value = String(s.voskVoice)
  } else {
    const voices = speechSynthesis?.getVoices?.().filter((v) => v.lang.toLowerCase().startsWith('ru')) ?? []
    if (!voices.length) sel.append(new Option('Голос по умолчанию', ''))
    for (const v of voices) sel.append(new Option(`${v.name}${v.localService ? '' : ' (онлайн)'}`, v.voiceURI))
    sel.value = s.systemVoice
    if (sel.selectedIndex < 0) sel.selectedIndex = 0
  }
  sel.onchange = () => {
    if (settings.s.engine === 'vosk') settings.set({ voskVoice: +sel.value })
    else settings.set({ systemVoice: sel.value })
  }
}

function exportNotes(title: string, chapters: string[], hls: Highlight[]): void {
  const lines = [`# ${title}`, '', `_Выделения и заметки, ${new Date().toLocaleDateString('ru-RU')}_`, '']
  let ch = -1
  for (const h of hls) {
    if (h.ch !== ch) { ch = h.ch; lines.push(`## ${chapters[ch] ?? 'Глава ' + (ch + 1)}`, '') }
    lines.push(`> ${h.text.replace(/\n/g, '\n> ')}`, '')
    if (h.note) lines.push(h.note, '')
  }
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)} — заметки.md`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  toast('Файл с заметками сохранён')
}

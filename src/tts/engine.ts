import type { Position } from '../book/types'
import type { ChapterData } from '../text/segment'
import { ttsText, wordWeight } from '../text/segment'
import { settings } from '../settings'
import type { WorkerIn, WorkerOut } from './vosk.worker'

export type TtsState = 'idle' | 'loading' | 'playing' | 'paused'

export interface SpeechSource {
  chapterCount(): number
  data(ch: number): ChapterData
}

export interface SpeechEvents {
  state(s: TtsState): void
  sentence(p: Position): void
  word(ch: number, w: number): void
  loading(progress: number | null, label: string): void
  error(msg: string): void
  finished(): void
  /** Спросить разрешение скачать модель. true — качать, false — системный голос, null — отмена. */
  askModel(): Promise<boolean | null>
}

interface Callbacks {
  start(): void
  word(w: number): void
  end(): void
  error(e: unknown): void
}

interface Engine {
  speak(ch: number, s: number, cb: Callbacks): void
  pause(): void
  resume(): void
  stop(): void
  setPlaybackRate(r: number): void
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

// ---------- WAV ----------

function wavUrl(pcm: Int16Array, rate: number): string {
  const buf = new ArrayBuffer(44 + pcm.length * 2)
  const v = new DataView(buf)
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  w(36, 'data'); v.setUint32(40, pcm.length * 2, true)
  new Int16Array(buf, 44).set(pcm)
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
}

const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA='

/** Границы речи в отсчётах (без тишины в начале и конце). */
function speechSpan(a: Int16Array, rate: number): [number, number] {
  const frame = Math.round(rate * 0.01), thr = 900
  let s = 0, e = a.length
  outer: for (let i = 0; i < a.length; i += frame) {
    for (let j = i; j < Math.min(a.length, i + frame); j++) if (Math.abs(a[j]) > thr) { s = i; break outer }
  }
  outer2: for (let i = a.length - frame; i > s; i -= frame) {
    for (let j = i; j < Math.min(a.length, i + frame); j++) if (Math.abs(a[j]) > thr) { e = Math.min(a.length, i + frame); break outer2 }
  }
  return [s, Math.max(s + 1, e)]
}

// ---------- Vosk ----------

interface Clip { url: string; w0: number; starts: Float32Array; dur: number }
interface Job { key: string; ch: number; s: number }

class VoskEngine implements Engine {
  private worker: Worker | null = null
  private ready: Promise<string> | null = null
  backend = ''
  loaded = false
  private reqId = 0
  private reqs = new Map<number, { res: (r: { audio: Int16Array; sampleRate: number }) => void; rej: (e: Error) => void }>()
  private clips = new Map<string, Clip>()
  private waiters = new Map<string, { res: (c: Clip) => void; rej: (e: unknown) => void }[]>()
  private queue: Job[] = []
  private busy: string | null = null
  private audio = new Audio()
  private preview = new Audio()
  private playSeq = 0
  private raf = 0
  private tick: (() => void) | null = null
  private onProgress: (p: number, label: string) => void

  private src: SpeechSource

  constructor(src: SpeechSource, onProgress: (p: number, label: string) => void) {
    this.src = src
    this.onProgress = onProgress
    this.audio.preload = 'auto'
    ;(this.audio as HTMLAudioElement & { preservesPitch: boolean }).preservesPitch = true
    settings.on((_, ch) => {
      if (ch.some((k) => k === 'voskVoice' || k === 'speechRate' || k === 'expressiveness')) this.invalidate()
    })
  }

  /** Разблокировка звука в Safari: play() нужно вызвать прямо в обработчике жеста. */
  unlock(): void {
    if (this.audio.src) return
    this.audio.src = SILENT_WAV
    this.audio.play().catch(() => {})
  }

  load(): Promise<string> {
    if (this.ready) return this.ready
    this.ready = new Promise<string>((res, rej) => {
      const w = new Worker(new URL('./vosk.worker.ts', import.meta.url), { type: 'module' })
      this.worker = w
      w.onmessage = (e: MessageEvent<WorkerOut>) => {
        const m = e.data
        if (m.type === 'progress') this.onProgress(m.overall, m.cached ? 'Загрузка модели из кэша' : 'Скачивание модели')
        else if (m.type === 'ready') { this.loaded = true; this.backend = m.backend; res(m.backend); this.pump() }
        else if (m.type === 'audio') { this.reqs.get(m.id)?.res(m); this.reqs.delete(m.id) }
        else if (m.type === 'error') {
          if (m.id == null) { this.ready = null; this.worker?.terminate(); this.worker = null; rej(new Error(m.message)) }
          else { this.reqs.get(m.id)?.rej(new Error(m.message)); this.reqs.delete(m.id) }
        }
      }
      w.onerror = (e) => { this.ready = null; this.worker = null; rej(new Error(e.message || 'Ошибка потока синтеза')) }
      const wasmPaths = new URL('ort/', document.baseURI).href
      const threads = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))
      w.postMessage({ type: 'init', backend: settings.s.backend, wasmPaths, threads } satisfies WorkerIn)
    })
    return this.ready
  }

  private synthRaw(text: string): Promise<{ audio: Int16Array; sampleRate: number }> {
    const id = ++this.reqId
    const s = settings.s
    return new Promise((res, rej) => {
      this.reqs.set(id, { res, rej })
      this.worker!.postMessage({ type: 'synth', id, text, speaker: s.voskVoice, speechRate: s.speechRate, noise: s.expressiveness } satisfies WorkerIn)
    })
  }

  private key(ch: number, s: number) { return `${ch}:${s}` }

  private invalidate(): void {
    // Играющий сейчас фрагмент дозвучит, его URL не трогаем.
    for (const c of this.clips.values()) if (c.url !== this.audio.src) URL.revokeObjectURL(c.url)
    this.clips.clear()
    this.queue = this.queue.filter((j) => this.waiters.has(j.key))
  }

  private async synthClip(ch: number, s: number): Promise<Clip> {
    const cd = this.src.data(ch)
    const sent = cd.sents[s]
    // Длинные предложения синтезируем частями по знакам препинания.
    const parts: [number, number][] = []
    let a = sent.w0, len = 0
    for (let i = sent.w0; i < sent.w1; i++) {
      len += cd.words[i].spoken.length + 1
      const brk = cd.words[i].pause > 0 && len > 140 || len > 260
      if (brk && i + 1 < sent.w1) { parts.push([a, i + 1]); a = i + 1; len = 0 }
    }
    parts.push([a, sent.w1])

    const chunks: Int16Array[] = []
    const starts = new Float32Array(sent.w1 - sent.w0)
    let rate = 22050, offset = 0
    for (const [p0, p1] of parts) {
      const text = ttsText(cd, sent, p0, p1)
      let audio: Int16Array
      try {
        const r = await this.synthRaw(text)
        audio = r.audio; rate = r.sampleRate
      } catch (e) {
        // Запасной вариант: без пунктуации (на редких символах BERT и g2p могут разойтись).
        const plain = text.replace(/[^а-яё+\s-]/gi, ' ').replace(/\s+/g, ' ').trim() + '.'
        const r = await this.synthRaw(plain)
        audio = r.audio; rate = r.sampleRate
        console.warn('Повторный синтез без пунктуации:', e)
      }
      const [s0, s1] = speechSpan(audio, rate)
      let total = 0
      const ws: number[] = [], gaps: number[] = []
      for (let i = p0; i < p1; i++) {
        const w = cd.words[i]
        ws.push(wordWeight(w))
        gaps.push(i + 1 < p1 ? (w.pause === 2 ? 1.6 : w.pause === 1 ? 0.8 : 0) : 0)
      }
      total = ws.reduce((x, y) => x + y, 0) + gaps.reduce((x, y) => x + y, 0)
      const k = (s1 - s0) / rate / total
      let t = (offset + s0) / rate
      for (let i = p0; i < p1; i++) {
        starts[i - sent.w0] = t
        t += (ws[i - p0] + gaps[i - p0]) * k
      }
      chunks.push(audio)
      offset += audio.length
    }
    const pcm = new Int16Array(offset)
    let o = 0
    for (const c of chunks) { pcm.set(c, o); o += c.length }
    return { url: wavUrl(pcm, rate), w0: sent.w0, starts, dur: pcm.length / rate }
  }

  private async pump(): Promise<void> {
    if (this.busy || !this.loaded) return
    const job = this.queue.shift()
    if (!job) return
    if (this.clips.has(job.key)) { this.resolve(job.key, this.clips.get(job.key)!); this.pump(); return }
    this.busy = job.key
    const gen = this.genOf()
    try {
      const clip = await this.synthClip(job.ch, job.s)
      if (gen !== this.genOf()) { URL.revokeObjectURL(clip.url); this.queue.unshift(job) } // настройки сменились — пересинтезировать
      else {
        this.clips.set(job.key, clip)
        this.evict()
        this.resolve(job.key, clip)
      }
    } catch (e) {
      const ws = this.waiters.get(job.key) ?? []
      this.waiters.delete(job.key)
      for (const w of ws) w.rej(e)
    } finally {
      this.busy = null
      this.pump()
    }
  }

  private genOf(): string {
    const s = settings.s
    return `${s.voskVoice}|${s.speechRate}|${s.expressiveness}`
  }

  private resolve(key: string, clip: Clip): void {
    const ws = this.waiters.get(key) ?? []
    this.waiters.delete(key)
    for (const w of ws) w.res(clip)
  }

  private evict(): void {
    while (this.clips.size > 40) {
      const [k, c] = this.clips.entries().next().value!
      if (c.url === this.audio.src) break
      URL.revokeObjectURL(c.url)
      this.clips.delete(k)
    }
  }

  private request(ch: number, s: number): Promise<Clip> {
    const key = this.key(ch, s)
    const hit = this.clips.get(key)
    if (hit) return Promise.resolve(hit)
    return new Promise((res, rej) => {
      const ws = this.waiters.get(key) ?? []
      ws.push({ res, rej })
      this.waiters.set(key, ws)
      if (this.busy !== key) {
        this.queue = this.queue.filter((j) => j.key !== key)
        this.queue.unshift({ key, ch, s })
      }
      this.pump()
    })
  }

  /** Заранее синтезировать следующие предложения; устаревшие задания выкидываются. */
  private prefetch(ch: number, s: number): void {
    this.queue = this.queue.filter((j) => this.waiters.has(j.key))
    let c = ch, i = s
    for (let n = 0; n < 3; n++) {
      const cd = this.src.data(c)
      i++
      while (i < cd.sents.length && cd.sents[i].w1 === cd.sents[i].w0) i++
      if (i >= cd.sents.length) {
        if (c + 1 >= this.src.chapterCount()) break
        c++; i = -1; n--; continue
      }
      const key = this.key(c, i)
      if (!this.clips.has(key) && this.busy !== key && !this.queue.some((j) => j.key === key)) this.queue.push({ key, ch: c, s: i })
    }
    this.pump()
  }

  speak(ch: number, s: number, cb: Callbacks): void {
    const my = ++this.playSeq
    this.stopAudio()
    this.load()
      .then(() => {
        const p = this.request(ch, s)
        this.prefetch(ch, s)
        return p
      })
      .then((clip) => {
        if (my !== this.playSeq) return
        const a = this.audio
        a.src = clip.url
        a.playbackRate = settings.s.playbackRate
        a.onended = () => { if (my === this.playSeq) { cancelAnimationFrame(this.raf); cb.end() } }
        let last = -1
        const tick = () => {
          if (my !== this.playSeq) return
          cancelAnimationFrame(this.raf)
          const t = a.currentTime
          let i = last < 0 ? 0 : last
          while (i + 1 < clip.starts.length && clip.starts[i + 1] <= t) i++
          while (i > 0 && clip.starts[i] > t) i--
          if (i !== last) { last = i; cb.word(clip.w0 + i) }
          if (!a.paused) this.raf = requestAnimationFrame(tick)
        }
        this.tick = tick
        a.play().then(() => {
          if (my !== this.playSeq) return
          cb.start()
          tick()
        }).catch((e) => { if (my === this.playSeq) cb.error(e) })
      })
      .catch((e) => { if (my === this.playSeq) cb.error(e) })
  }

  private stopAudio(): void {
    cancelAnimationFrame(this.raf)
    this.audio.onended = null
    this.audio.pause()
  }

  pause(): void { cancelAnimationFrame(this.raf); this.audio.pause() }
  resume(): void {
    const seq = this.playSeq
    // После паузы перезапускаем цикл подсветки.
    this.audio.play().then(() => { if (seq === this.playSeq) this.tick?.() }).catch(() => {})
  }
  stop(): void { this.playSeq++; this.stopAudio() }
  setPlaybackRate(r: number): void { this.audio.playbackRate = r; this.preview.playbackRate = r }

  async previewVoice(text: string): Promise<void> {
    await this.load()
    const { audio, sampleRate } = await this.synthRaw(text)
    const url = wavUrl(audio, sampleRate)
    this.preview.src = url
    this.preview.playbackRate = settings.s.playbackRate
    ;(this.preview as HTMLAudioElement & { preservesPitch: boolean }).preservesPitch = true
    this.preview.onended = () => URL.revokeObjectURL(url)
    await this.preview.play()
  }
}

// ---------- Системный голос (Web Speech API) ----------

class SystemEngine implements Engine {
  private seq = 0
  private src: SpeechSource
  constructor(src: SpeechSource) { this.src = src }

  static available(): boolean { return 'speechSynthesis' in window }

  static voices(): SpeechSynthesisVoice[] {
    if (!SystemEngine.available()) return []
    const all = speechSynthesis.getVoices()
    const ru = all.filter((v) => v.lang.toLowerCase().startsWith('ru'))
    return ru.length ? ru : all
  }

  private utter(text: string): SpeechSynthesisUtterance {
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'ru-RU'
    const v = SystemEngine.voices().find((x) => x.voiceURI === settings.s.systemVoice) ?? SystemEngine.voices()[0]
    if (v) u.voice = v
    u.rate = clamp(settings.s.playbackRate * settings.s.speechRate, 0.1, 10)
    return u
  }

  speak(ch: number, s: number, cb: Callbacks): void {
    const my = ++this.seq
    speechSynthesis.cancel()
    const cd = this.src.data(ch)
    const sent = cd.sents[s]
    let text = ''
    const offs: [number, number][] = []
    for (const t of sent.toks) {
      if (t.k === 'w') { offs.push([text.length, t.i]); text += cd.words[t.i].t }
      else if (t.k === 't') text += t.v
    }
    const u = this.utter(text)
    u.onstart = () => { if (my === this.seq) { cb.start(); if (offs.length) cb.word(offs[0][1]) } }
    u.onboundary = (e) => {
      if (my !== this.seq || (e.name && e.name !== 'word')) return
      let w = offs[0]?.[1] ?? -1
      for (const [o, i] of offs) { if (o <= e.charIndex) w = i; else break }
      if (w >= 0) cb.word(w)
    }
    u.onend = () => { if (my === this.seq) cb.end() }
    u.onerror = (e) => {
      if (my !== this.seq || e.error === 'interrupted' || e.error === 'canceled') return
      cb.error(new Error(e.error))
    }
    // Chrome иногда «залипает» после cancel(): небольшая задержка помогает.
    setTimeout(() => { if (my === this.seq) speechSynthesis.speak(u) }, 30)
  }

  pause(): void { speechSynthesis.pause() }
  resume(): void { speechSynthesis.resume() }
  stop(): void { this.seq++; speechSynthesis.cancel() }
  setPlaybackRate(): void { /* применится со следующего предложения */ }

  previewVoice(text: string): void {
    speechSynthesis.cancel()
    speechSynthesis.speak(this.utter(text))
  }
}

// ---------- Контроллер ----------

export class Speech {
  state: TtsState = 'idle'
  pos: Position | null = null
  readonly vosk: VoskEngine
  private sys: SystemEngine
  private engine: Engine | null = null
  private restartOnResume = false
  private failures = 0
  private playToken = 0

  private src: SpeechSource
  private ev: SpeechEvents

  constructor(src: SpeechSource, ev: SpeechEvents) {
    this.src = src
    this.ev = ev
    this.vosk = new VoskEngine(src, (p, label) => { if (this.state === 'loading') ev.loading(p, label) })
    this.sys = new SystemEngine(src)
    settings.on((s, ch) => {
      if (ch.includes('playbackRate')) this.engine?.setPlaybackRate(s.playbackRate)
      if (ch.includes('engine') && this.state !== 'idle') {
        const p = this.pos
        this.stop()
        if (p) this.play(p)
      }
    })
  }

  get active(): boolean { return this.state !== 'idle' }

  static systemVoices = SystemEngine.voices
  static systemAvailable = SystemEngine.available

  private setState(s: TtsState): void {
    if (this.state === s) return
    this.state = s
    this.ev.state(s)
  }

  /** Первое непустое предложение начиная с p в направлении dir. */
  private seek(p: Position, dir: 1 | -1, includeSelf: boolean): Position | null {
    let { ch, s } = p
    if (!includeSelf) s += dir
    for (;;) {
      if (ch < 0 || ch >= this.src.chapterCount()) return null
      const cd = this.src.data(ch)
      if (s < 0) { ch--; if (ch < 0) return null; s = this.src.data(ch).sents.length - 1; continue }
      if (s >= cd.sents.length) { ch++; s = 0; continue }
      if (cd.sents[s].w1 > cd.sents[s].w0) return { ch, s }
      s += dir
    }
  }

  private async pickEngine(): Promise<Engine | null> {
    if (settings.s.engine === 'system') {
      if (!SystemEngine.available()) { this.ev.error('Системный синтез речи недоступен в этом браузере'); return null }
      return this.sys
    }
    if (!this.vosk.loaded) {
      const consent = localStorage.getItem('cr:modelConsent') === '1' || (await this.ev.askModel())
      if (consent === null) return null
      if (consent === false) {
        settings.set({ engine: 'system' })
        return SystemEngine.available() ? this.sys : null
      }
      try { localStorage.setItem('cr:modelConsent', '1') } catch { /* ignore */ }
      this.setState('loading')
      this.ev.loading(0, 'Подготовка синтезатора')
      try {
        await this.vosk.load()
      } catch (e) {
        this.ev.loading(null, '')
        this.ev.error('Не удалось загрузить голосовую модель: ' + (e as Error).message)
        this.setState('idle')
        return null
      }
      this.ev.loading(null, '')
    }
    return this.vosk
  }

  /** Вызывать прямо из обработчика клика/клавиши. */
  async play(from: Position): Promise<void> {
    this.vosk.unlock()
    const p = this.seek(from, 1, true)
    if (!p) return
    const token = ++this.playToken
    this.engine?.stop()
    this.pos = p
    this.ev.sentence(p)
    const eng = await this.pickEngine()
    if (!eng) { if (this.state === 'loading') this.setState('idle'); return }
    this.engine = eng
    this.engine.setPlaybackRate(settings.s.playbackRate)
    // Пока грузилась модель, чтение могли остановить, перезапустить или поставить на паузу.
    if (token !== this.playToken) return
    if (this.state === 'paused') { this.restartOnResume = true; return }
    this.speakCurrent()
  }

  private speakCurrent(): void {
    const p = this.pos!
    this.restartOnResume = false
    this.ev.sentence(p)
    if (this.state !== 'playing') this.setState('loading')
    this.engine!.speak(p.ch, p.s, {
      start: () => { this.failures = 0; this.setState('playing') },
      word: (w) => this.ev.word(p.ch, w),
      end: () => this.advance(),
      error: (e) => {
        console.warn('TTS:', e)
        if ((e as Error)?.name === 'NotAllowedError') { this.setState('paused'); this.restartOnResume = true; return }
        if (++this.failures > 3) { this.ev.error('Ошибка озвучивания: ' + ((e as Error)?.message ?? e)); this.stop(); return }
        this.advance()
      },
    })
  }

  private advance(): void {
    const n = this.pos && this.seek(this.pos, 1, false)
    if (!n) { this.stop(); this.ev.finished(); return }
    this.pos = n
    this.speakCurrent()
  }

  async toggle(from: Position): Promise<void> {
    if (this.state === 'playing' || this.state === 'loading') this.pause()
    else if (this.state === 'paused') this.resume()
    else await this.play(from)
  }

  pause(): void {
    if (this.state === 'idle') return
    if (this.state === 'loading') { this.engine?.stop(); this.restartOnResume = true }
    else this.engine?.pause()
    this.setState('paused')
  }

  resume(): void {
    if (this.state !== 'paused') return
    this.vosk.unlock()
    if (this.restartOnResume || !this.engine) { if (this.engine) this.speakCurrent(); else if (this.pos) this.play(this.pos) }
    else { this.engine.resume(); this.setState('playing') }
  }

  stop(): void {
    this.playToken++
    this.engine?.stop()
    this.restartOnResume = false
    this.setState('idle')
    if (this.pos) this.ev.word(this.pos.ch, -1)
  }

  /** Перейти на соседнее предложение (dir = ±1) или на конкретную позицию. */
  jump(dir: 1 | -1 | Position): void {
    if (!this.pos) return
    const n = typeof dir === 'number' ? this.seek(this.pos, dir, false) : this.seek(dir, 1, true)
    if (!n) return
    this.pos = n
    if (this.state === 'paused' || !this.engine) {
      this.engine?.stop()
      this.restartOnResume = true
      this.ev.sentence(n)
      this.ev.word(n.ch, -1)
      return
    }
    this.engine.stop()
    this.speakCurrent()
  }

  async previewVoice(text: string): Promise<void> {
    if (settings.s.engine === 'system') { this.sys.previewVoice(text); return }
    if (!this.vosk.loaded) {
      const ok = localStorage.getItem('cr:modelConsent') === '1' || (await this.ev.askModel())
      if (!ok) return
      try { localStorage.setItem('cr:modelConsent', '1') } catch { /* ignore */ }
    }
    this.ev.loading(0, 'Подготовка синтезатора')
    const prev = this.state
    this.state = 'loading'
    try { await this.vosk.previewVoice(text) } catch (e) { this.ev.error('Не удалось озвучить пример: ' + (e as Error).message) } finally {
      this.state = prev
      this.ev.loading(null, '')
    }
  }
}

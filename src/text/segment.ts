import type { Chapter } from '../book/types'
import { spokenWord, ttsPunct } from './normalize'

export const FN_RE = /\[\[fn:([^\]]+)\]\]/g

export type Tok =
  | { k: 'w'; i: number }
  | { k: 't'; v: string }
  | { k: 'fn'; id: string }

export interface Word {
  /** Слово как в тексте. */
  t: string
  /** Индекс предложения. */
  s: number
  /** Индекс абзаца. */
  b: number
  /** Слово с прилегающей пунктуацией (для RSVP). */
  disp: string
  /** Как произносить (цифры словами, латиница кириллицей). */
  spoken: string
  /** Пауза после слова: 0 — нет, 1 — запятая, 2 — конец фразы. */
  pause: 0 | 1 | 2
}

export interface Sent {
  b: number
  w0: number
  w1: number
  toks: Tok[]
  /** Текст без сносок. */
  text: string
}

export interface BlockData {
  k: string
  lvl?: number
  s0: number
  s1: number
}

export interface ChapterData {
  blocks: BlockData[]
  sents: Sent[]
  words: Word[]
}

// Сокращения, после которых точка не завершает предложение.
const ABBR = new Set(
  'т е д п г гг в вв им ул пл стр рис см др пр напр тыс млн млрд руб коп проф акад доц ген кн св ср англ лат франц нем греч ст ок мин сек табл гл изд т.е т.д т.п т.к и.о н.э до н.э'.split(' '),
)

const SENT_END = /([.!?…]+)((?:["»”)\]’']|\[\[fn:[^\]]+\]\])*)(\s+)/g
const STARTS_SENT = /^[\p{Lu}\p{N}«"“„(\[—–-]/u

export function splitSentences(text: string): string[] {
  const out: string[] = []
  let start = 0
  SENT_END.lastIndex = 0
  for (let m; (m = SENT_END.exec(text)); ) {
    const next = text.slice(SENT_END.lastIndex, SENT_END.lastIndex + 1)
    if (!STARTS_SENT.test(next)) continue
    // «Правда?» — спросил он. Слова автора после тире продолжают предложение.
    if (/[—–-]/.test(next) && /^[—–-]\s*\p{Ll}/u.test(text.slice(SENT_END.lastIndex))) continue
    if (m[1] === '.') {
      const before = text.slice(start, m.index)
      const last = /([\p{L}.]+)$/u.exec(before)?.[1] ?? ''
      // «и т. д.», «и т. п.» обычно завершают фразу.
      const etc = /(^|\s)т\.\s?[дп]$/.test(before)
      if (!etc && (ABBR.has(last.toLowerCase()) || /^\p{Lu}$/u.test(last))) continue
    }
    const end = m.index + m[1].length + m[2].length
    const s = text.slice(start, end).trim()
    if (s) out.push(s)
    start = SENT_END.lastIndex
  }
  const rest = text.slice(start).trim()
  if (rest) out.push(rest)
  return out
}

const WORD_RE = /[\p{L}\p{N}\p{M}]+(?:[-‐'’][\p{L}\p{N}\p{M}]+)*(?:[.,]\p{N}+)*/gu

export function countWords(text: string): number {
  return text.replace(FN_RE, '').match(WORD_RE)?.length ?? 0
}

function pauseOf(punct: string): 0 | 1 | 2 {
  if (/[.!?…]/.test(punct)) return 2
  if (/[,;:—–()-]/.test(punct)) return 1
  return 0
}

/** Разбивает главу на абзацы → предложения → слова. */
export function analyzeChapter(ch: Chapter): ChapterData {
  const blocks: BlockData[] = [], sents: Sent[] = [], words: Word[] = []
  ch.blocks.forEach((blk, b) => {
    const s0 = sents.length
    if (blk.k !== 'sep') {
      const parts = blk.k === 'verse' ? blk.text.split('\n').filter((x) => x.trim()) : splitSentences(blk.text)
      for (const raw of parts) {
        const sIdx = sents.length
        const toks: Tok[] = []
        const w0 = words.length
        let pending = ''      // пунктуация перед словом (открывающие кавычки)
        let pos = 0
        const pushText = (v: string) => {
          if (!v) return
          toks.push({ k: 't', v })
          const prev = words.length > w0 ? words[words.length - 1] : null
          // Прилегающая пунктуация: до пробела — к предыдущему слову, после пробела — к следующему.
          const [, tail, mid, head] = /^(\S*)([\s\S]*?)(\S*)$/.exec(v)!
          if (!prev) { pending += (tail + head).replace(/[—–-]/g, ''); return }
          prev.disp += tail
          prev.pause = Math.max(prev.pause, pauseOf(tail + mid)) as 0 | 1 | 2
          pending = head
        }
        const text = raw.replace(FN_RE, (_, id) => `\u0000${id}\u0000`)
        const fnParts = text.split('\u0000')
        fnParts.forEach((part, pi) => {
          if (pi % 2 === 1) { toks.push({ k: 'fn', id: part }); return }
          pos = 0
          WORD_RE.lastIndex = 0
          for (let m; (m = WORD_RE.exec(part)); ) {
            pushText(part.slice(pos, m.index))
            const t = m[0]
            toks.push({ k: 'w', i: words.length })
            words.push({ t, s: sIdx, b, disp: pending + t, spoken: spokenWord(t), pause: 0 })
            pending = ''
            pos = m.index + t.length
          }
          pushText(part.slice(pos))
        })
        if (words.length === w0) {
          // Предложение без слов (например, «* * *») — склеиваем с соседним текстом.
          if (sents.length > s0) sents[sents.length - 1].toks.push({ k: 't', v: ' ' }, ...toks)
          else toks.length && sents.push({ b, w0, w1: w0, toks, text: raw.replace(FN_RE, '') })
          continue
        }
        if (blk.k === 'verse' || blk.k === 'h') words[words.length - 1].pause = 2
        sents.push({ b, w0, w1: words.length, toks, text: raw.replace(FN_RE, '') })
      }
    }
    blocks.push({ k: blk.k, lvl: blk.lvl, s0, s1: sents.length })
  })
  return { blocks, sents, words }
}

/** Текст предложения для синтезатора Vosk по диапазону слов [w0, w1). */
export function ttsText(cd: ChapterData, s: Sent, w0 = s.w0, w1 = s.w1): string {
  let out = ''
  for (const tok of s.toks) {
    if (tok.k === 'w') {
      if (tok.i < w0 || tok.i >= w1) continue
      out += cd.words[tok.i].spoken
    } else if (tok.k === 't') {
      out += ttsPunct(tok.v)
    }
  }
  if (w0 !== s.w0) out = out.replace(/^[^\p{L}"]+/u, '')
  out = out.replace(/\s+/g, ' ').replace(/\s+([,.?!;:)])/g, '$1').trim()
  if (w1 !== s.w1) out = out.replace(/[\s,;:-]+$/u, '') + ','
  if (!/[.?!]$/.test(out)) out = out.replace(/[\s,;:-]+$/u, '') + '.'
  return out
}

/** Вес слова для оценки длительности произнесения. */
export function wordWeight(w: Word): number {
  const v = w.spoken.match(/[аеёиоуыэюя]/gi)?.length ?? 0
  return Math.max(1, v) + w.spoken.length * 0.15
}

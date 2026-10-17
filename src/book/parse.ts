import type { Block, Book, Chapter } from './types'
import { countWords } from '../text/segment'
import { readZip } from './zip'

const MAX_CHAPTER_WORDS = 6000

export class ParseError extends Error {}

/** Читает файл книги любого поддерживаемого формата. */
export async function parseFile(file: File): Promise<Book> {
  const name = file.name.toLowerCase()
  const bytes = new Uint8Array(await file.arrayBuffer())
  const base = file.name.replace(/\.[^.]+$/, '').replace(/\.fb2$/i, '')
  if (name.endsWith('.epub')) return parseEpub(bytes, base)
  if (name.endsWith('.fb2.zip') || (name.endsWith('.zip') && bytes[0] === 0x50)) {
    const files = await readZip(bytes)
    const fb2 = [...files.keys()].find((k) => k.toLowerCase().endsWith('.fb2'))
    if (!fb2) throw new ParseError('В архиве нет файла .fb2')
    return parseFb2(await files.get(fb2)!(), base)
  }
  if (name.endsWith('.fb2')) return parseFb2(bytes, base)
  const text = decodeText(bytes)
  if (name.endsWith('.html') || name.endsWith('.htm') || name.endsWith('.xhtml')) return parseHtml(text, base)
  if (name.endsWith('.md') || name.endsWith('.markdown')) return parseMarkdown(text, base)
  return parsePlain(text, base)
}

/** UTF-8, при ошибке — windows-1251 (частая кодировка старых русских txt/fb2). */
export function decodeText(bytes: Uint8Array, hint?: string): string {
  if (hint) {
    try { return new TextDecoder(hint).decode(bytes) } catch { /* неизвестная кодировка */ }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1251').decode(bytes)
  }
}

const clean = (s: string) => s.replace(/­/g, '').replace(/[ \t ]+/g, ' ').trim()

/** Общая доводка: делит длинные главы, считает слова, вычисляет id. */
export function finalizeBook(title: string, chapters: Chapter[], notes: Record<string, string> = {}, author?: string): Book {
  const out: Chapter[] = []
  for (const ch of chapters) {
    const blocks = ch.blocks.filter((b) => b.k === 'sep' || b.text.trim())
    if (!blocks.length) continue
    let part: Block[] = [], words = 0, n = 1
    const flush = (last: boolean) => {
      if (!part.length) return
      const t = n > 1 || !last ? `${ch.title} (часть ${n})` : ch.title
      out.push({ title: t, blocks: part, words })
      part = []; words = 0; n++
    }
    for (const b of blocks) {
      const w = countWords(b.text)
      if (words + w > MAX_CHAPTER_WORDS && words > MAX_CHAPTER_WORDS / 3) flush(false)
      part.push(b); words += w
    }
    if (n === 1) { out.push({ title: ch.title, blocks: part, words }); part = [] } else flush(true)
  }
  if (!out.length) throw new ParseError('В файле не найден текст')
  const sample = out.map((c) => c.title).join('|') + out.slice(0, 3).flatMap((c) => c.blocks.slice(0, 30).map((b) => b.text)).join('\n')
  return { id: 'b' + hash(title + '|' + sample + '|' + out.length), title, author, chapters: out, notes, addedAt: Date.now() }
}

function hash(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619)
    h2 = Math.imul(h2 ^ c, 2246822519)
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)
}

// ---------- TXT ----------

const CHAPTER_LINE = /^\s*((глава|часть|книга|пролог|эпилог|предисловие|послесловие|chapter|part)\b[^\n]{0,80}|[IVXLC]{1,7}\.?|\d{1,3}\.?)\s*$/i

export function parsePlain(text: string, title: string): Book {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const hasBlank = lines.filter((l) => !l.trim()).length > lines.length * 0.15
  const chapters: Chapter[] = []
  let cur: Chapter = { title, blocks: [], words: 0 }
  let para: string[] = []
  const flushPara = () => {
    const t = clean(para.join(' '))
    if (t) cur.blocks.push({ k: /^(\*\s*){3}$/.test(t) ? 'sep' : 'p', text: t })
    para = []
  }
  for (const line of lines) {
    const t = line.trim()
    if (!t) { flushPara(); continue }
    if (CHAPTER_LINE.test(t) && t.length < 90) {
      flushPara()
      if (cur.blocks.length) chapters.push(cur)
      cur = { title: clean(t), blocks: [], words: 0 }
      continue
    }
    if (!hasBlank || /^\s{2,}|^\t/.test(line)) flushPara()
    para.push(t)
  }
  flushPara()
  chapters.push(cur)
  return finalizeBook(title, chapters)
}

// ---------- Markdown ----------

export function parseMarkdown(text: string, title: string): Book {
  const notes: Record<string, string> = {}
  text = text.replace(/\r\n?/g, '\n').replace(/^\[\^([^\]]+)\]:\s*(.+)$/gm, (_, id, body) => { notes[id] = clean(body); return '' })
  const inline = (s: string) => clean(s
    .replace(/\[\^([^\]]+)\]/g, '[[fn:$1]]')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/`([^`]+)`/g, '$1'))
  const top = /^# /m.test(text) ? 1 : 2
  const chapters: Chapter[] = []
  let cur: Chapter = { title, blocks: [], words: 0 }
  for (const raw of text.split(/\n{2,}/)) {
    const t = raw.trim()
    if (!t) continue
    const h = /^(#{1,6})\s+(.+)$/.exec(t.split('\n')[0])
    if (h) {
      const lvl = h[1].length
      if (lvl <= top) {
        if (cur.blocks.length) chapters.push(cur)
        cur = { title: inline(h[2]), blocks: [], words: 0 }
      } else cur.blocks.push({ k: 'h', lvl: Math.min(4, lvl - top), text: inline(h[2]) })
      const rest = t.split('\n').slice(1).join('\n').trim()
      if (rest) cur.blocks.push({ k: 'p', text: inline(rest) })
      continue
    }
    if (/^([-*_]\s*){3,}$/.test(t)) { cur.blocks.push({ k: 'sep', text: '' }); continue }
    if (t.startsWith('>')) { cur.blocks.push({ k: 'quote', text: inline(t.replace(/^>\s?/gm, '')) }); continue }
    if (/^\s*([-*+]|\d+\.)\s/.test(t)) {
      for (const li of t.split(/\n(?=\s*(?:[-*+]|\d+\.)\s)/)) cur.blocks.push({ k: 'p', text: inline(li) })
      continue
    }
    cur.blocks.push({ k: 'p', text: inline(t) })
  }
  chapters.push(cur)
  return finalizeBook(title, chapters, notes)
}

// ---------- HTML (и главы EPUB) ----------

const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'LI', 'PRE', 'HR', 'DD', 'DT', 'FIGCAPTION', 'TD'])
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NAV', 'ASIDE', 'NOSCRIPT', 'SVG', 'MATH', 'HEAD', 'TEMPLATE'])

interface HtmlCtx {
  notes: Record<string, string>
  /** id элементов-сносок (aside/li с epub:type="footnote" и т.п.). */
  noteIds: Set<string>
  prefix: string
}

function inlineText(el: Element, ctx: HtmlCtx): string {
  let s = ''
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) s += n.textContent
    else if (n.nodeType === 1) {
      const e = n as Element
      if (SKIP_TAGS.has(e.tagName.toUpperCase())) continue
      if (e.tagName.toUpperCase() === 'BR') { s += ' '; continue }
      const type = e.getAttribute('epub:type') || e.getAttribute('type') || e.getAttribute('role') || ''
      const href = e.getAttribute('href') || e.getAttribute('l:href') || e.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href') || ''
      if (e.tagName.toUpperCase() === 'A' && href.includes('#') && (/noteref|note/.test(type) || /^\[?\*?\d{1,3}\]?$|^\*+$/.test((e.textContent || '').trim()))) {
        s += `[[fn:${ctx.prefix}${href.split('#').pop()}]]`
        continue
      }
      s += inlineText(e, ctx)
    }
  }
  return s
}

/** Абзацы из DOM-поддерева. Первый заголовок, если просят, отдаётся как название. */
export function blocksFromDom(root: Element, ctx: HtmlCtx): Block[] {
  const blocks: Block[] = []
  const walk = (el: Element, inQuote: boolean) => {
    for (const c of Array.from(el.children)) {
      const tag = c.tagName.toUpperCase().replace(/^.*:/, '')
      if (SKIP_TAGS.has(tag)) continue
      const type = c.getAttribute('epub:type') || c.getAttribute('role') || ''
      if (/footnote|endnote|rearnote|doc-footnote|doc-endnote/.test(type) && c.id) {
        ctx.notes[ctx.prefix + c.id] = clean(c.textContent || '')
        continue
      }
      if (/footnotes|endnotes|rearnotes|doc-endnotes/.test(type)) {
        for (const li of Array.from(c.querySelectorAll('[id]'))) ctx.notes[ctx.prefix + li.id] = clean(li.textContent || '').replace(/[↩︎⤴]+$/, '')
        continue
      }
      if (c.id && ctx.noteIds.has(c.id)) {
        ctx.notes[ctx.prefix + c.id] = clean(c.textContent || '')
        continue
      }
      if (tag === 'HR') { blocks.push({ k: 'sep', text: '' }); continue }
      const hasBlockKids = Array.from(c.children).some((k) => BLOCK_TAGS.has(k.tagName.toUpperCase()) || k.tagName.toUpperCase() === 'DIV' || k.tagName.toUpperCase() === 'SECTION')
      if (tag === 'BLOCKQUOTE' && hasBlockKids) { walk(c, true); continue }
      if (BLOCK_TAGS.has(tag) || (!hasBlockKids && (c.textContent || '').trim())) {
        const text = clean(inlineText(c, ctx))
        if (!text) continue
        if (/^H[1-6]$/.test(tag)) blocks.push({ k: 'h', lvl: +tag[1], text })
        else if (tag === 'PRE') for (const l of (c.textContent || '').split('\n')) { if (l.trim()) blocks.push({ k: 'verse', text: clean(l) }) }
        else blocks.push({ k: inQuote || tag === 'BLOCKQUOTE' ? 'quote' : 'p', text })
        continue
      }
      walk(c, inQuote)
    }
  }
  walk(root, false)
  return blocks
}

/** Заголовки в начале главы → название главы, остальные понижаются до подзаголовков. */
export function chapterFromBlocks(blocks: Block[], fallback: string): Chapter {
  let title = ''
  while (blocks.length && blocks[0].k === 'h' && title.length < 100) {
    title = title ? `${title}. ${blocks[0].text}` : blocks[0].text
    blocks.shift()
  }
  const minLvl = Math.min(...blocks.filter((b) => b.k === 'h').map((b) => b.lvl ?? 2), 9)
  for (const b of blocks) if (b.k === 'h') b.lvl = Math.min(4, (b.lvl ?? 2) - minLvl + 1)
  return { title: title || fallback, blocks, words: 0 }
}

export function parseHtml(text: string, title: string): Book {
  const doc = new DOMParser().parseFromString(text, 'text/html')
  const ctx: HtmlCtx = { notes: {}, noteIds: new Set(), prefix: '' }
  const docTitle = clean(doc.querySelector('title')?.textContent || '') || title
  const blocks = blocksFromDom(doc.body, ctx)
  // Главы — по заголовкам верхнего уровня.
  const top = [1, 2, 3].find((l) => blocks.filter((b) => b.k === 'h' && b.lvl === l).length >= 2) ?? 0
  const chapters: Chapter[] = []
  let cur: Block[] = []
  for (const b of blocks) {
    if (top && b.k === 'h' && (b.lvl ?? 9) <= top && cur.length) { chapters.push(chapterFromBlocks(cur, docTitle)); cur = [] }
    cur.push(b)
  }
  chapters.push(chapterFromBlocks(cur, docTitle))
  return finalizeBook(docTitle, chapters, ctx.notes)
}

// ---------- FB2 ----------

export function parseFb2(bytes: Uint8Array, fallback: string): Book {
  const head = new TextDecoder('ascii').decode(bytes.subarray(0, 200))
  const enc = /encoding=["']([^"']+)["']/i.exec(head)?.[1]
  const xml = decodeText(bytes, enc)
  let doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(xml, 'text/html')
  const q = (root: Element | Document, sel: string) => Array.from(root.getElementsByTagName(sel))
  const ti = q(doc, 'title-info')[0]
  const title = clean(ti ? q(ti, 'book-title')[0]?.textContent || '' : '') || fallback
  const a = ti ? q(ti, 'author')[0] : undefined
  const author = a ? clean(['first-name', 'middle-name', 'last-name'].map((t) => q(a, t)[0]?.textContent || '').join(' ')) : undefined

  const ctx: HtmlCtx = { notes: {}, noteIds: new Set(), prefix: '' }
  const bodies = q(doc, 'body')
  for (const b of bodies.filter((b) => /notes|comments/i.test(b.getAttribute('name') || ''))) {
    for (const s of q(b, 'section')) {
      const id = s.getAttribute('id')
      if (!id) continue
      const t = Array.from(s.children).filter((c) => c.localName !== 'title').map((c) => c.textContent || '').join(' ')
      ctx.notes[id] = clean(t)
    }
  }
  const main = bodies.find((b) => !/notes|comments/i.test(b.getAttribute('name') || '')) ?? bodies[0]
  if (!main) throw new ParseError('В FB2 нет текста')

  const textOf = (el: Element) => clean(inlineText(el, ctx))
  const titleOf = (el: Element) => {
    const t = Array.from(el.children).find((c) => c.localName === 'title')
    return t ? clean(Array.from(t.children).map((p) => textOf(p)).filter(Boolean).join('. ')) : ''
  }
  const blocksOf = (el: Element, depth: number, out: Block[]) => {
    for (const c of Array.from(el.children)) {
      switch (c.localName) {
        case 'title': if (depth > 0) out.push({ k: 'h', lvl: Math.min(4, depth), text: titleOf(el) }); break
        case 'p': out.push({ k: 'p', text: textOf(c) }); break
        case 'subtitle': out.push({ k: 'h', lvl: Math.min(4, depth + 1), text: textOf(c) }); break
        case 'empty-line': break
        case 'epigraph': case 'cite':
          for (const p of Array.from(c.children)) {
            if (p.localName === 'text-author') out.push({ k: 'quote', text: '— ' + textOf(p) })
            else if (p.localName === 'poem') for (const v of q(p, 'v')) out.push({ k: 'verse', text: textOf(v) })
            else out.push({ k: 'quote', text: textOf(p) })
          }
          break
        case 'poem':
          for (const st of Array.from(c.children)) {
            if (st.localName === 'title') out.push({ k: 'h', lvl: Math.min(4, depth + 1), text: titleOf(c) })
            else if (st.localName === 'stanza') { for (const v of q(st, 'v')) out.push({ k: 'verse', text: textOf(v) }); out.push({ k: 'sep', text: '' }) }
            else if (st.localName === 'text-author') out.push({ k: 'quote', text: '— ' + textOf(st) })
          }
          if (out.at(-1)?.k === 'sep') out.pop()
          break
        case 'section': blocksOf(c, depth + 1, out); break
        case 'table': out.push({ k: 'p', text: textOf(c) }); break
      }
    }
  }

  const chapters: Chapter[] = []
  const pre: Block[] = []
  for (const c of Array.from(main.children)) {
    if (c.localName === 'section') {
      const sub = Array.from(c.children).filter((x) => x.localName === 'section')
      const own = Array.from(c.children).filter((x) => x.localName === 'p').length
      // Часть с вложенными главами и без своего текста — разворачиваем.
      if (sub.length > 1 && own < 3) {
        const partTitle = titleOf(c)
        let first = true
        const intro: Block[] = []
        for (const x of Array.from(c.children)) {
          if (x.localName === 'section') {
            const blocks: Block[] = []
            blocksOf(x, 0, blocks)
            const t = titleOf(x) || partTitle
            chapters.push({ title: first && partTitle ? `${partTitle}. ${t}` : t, blocks: [...intro.splice(0), ...blocks], words: 0 })
            first = false
          } else if (x.localName !== 'title') blocksOf(wrap(x), 0, intro)
        }
        continue
      }
      const blocks: Block[] = []
      blocksOf(c, 0, blocks)
      chapters.push({ title: titleOf(c) || title, blocks, words: 0 })
    } else if (c.localName !== 'title') {
      blocksOf(wrap(c), 1, pre)
    }
  }
  if (pre.length) chapters.unshift({ title: titleOf(main) || title, blocks: pre, words: 0 })
  return finalizeBook(title, chapters, ctx.notes, author || undefined)
}

/** Оборачивает одиночный элемент, чтобы пройти его тем же обходчиком детей. */
function wrap(el: Element): Element {
  const w = el.ownerDocument.createElementNS(el.namespaceURI, 'wrap')
  w.appendChild(el.cloneNode(true))
  return w
}

// ---------- EPUB ----------

export async function parseEpub(bytes: Uint8Array, fallback: string): Promise<Book> {
  const files = await readZip(bytes)
  const read = async (p: string) => {
    const f = files.get(p) ?? files.get(decodeURIComponent(p))
    if (!f) throw new ParseError(`В EPUB нет файла ${p}`)
    return decodeText(await f())
  }
  const xml = (s: string) => new DOMParser().parseFromString(s, 'application/xml')
  const container = xml(await read('META-INF/container.xml'))
  const opfPath = container.getElementsByTagName('rootfile')[0]?.getAttribute('full-path')
  if (!opfPath) throw new ParseError('Повреждённый EPUB: нет OPF')
  const opf = xml(await read(opfPath))
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  const resolvePath = (base: string, href: string) => {
    const parts = (base + href.split('#')[0]).split('/')
    const out: string[] = []
    for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.') out.push(p) }
    return out.join('/')
  }
  const meta = (tag: string) => clean(opf.getElementsByTagNameNS('*', tag)[0]?.textContent || '')
  const title = meta('title') || fallback
  const author = meta('creator') || undefined
  const manifest = new Map<string, { href: string; type: string; props: string }>()
  for (const it of Array.from(opf.getElementsByTagNameNS('*', 'item'))) {
    manifest.set(it.getAttribute('id') || '', { href: it.getAttribute('href') || '', type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' })
  }
  const spine = Array.from(opf.getElementsByTagNameNS('*', 'itemref')).map((r) => r.getAttribute('idref') || '')

  // Названия глав из оглавления (nav.xhtml или toc.ncx).
  const tocTitles = new Map<string, string>()
  try {
    const nav = [...manifest.values()].find((m) => m.props.includes('nav'))
    if (nav) {
      const d = new DOMParser().parseFromString(await read(resolvePath(dir, nav.href)), 'application/xhtml+xml')
      const navDir = resolvePath(dir, nav.href).replace(/[^/]*$/, '')
      for (const a of Array.from(d.getElementsByTagName('a'))) {
        const p = resolvePath(navDir, a.getAttribute('href') || '')
        if (!tocTitles.has(p)) tocTitles.set(p, clean(a.textContent || ''))
      }
    } else {
      const ncx = [...manifest.values()].find((m) => m.type.includes('ncx'))
      if (ncx) {
        const d = xml(await read(resolvePath(dir, ncx.href)))
        const ncxDir = resolvePath(dir, ncx.href).replace(/[^/]*$/, '')
        for (const np of Array.from(d.getElementsByTagNameNS('*', 'navPoint'))) {
          const src = np.getElementsByTagNameNS('*', 'content')[0]?.getAttribute('src') || ''
          const p = resolvePath(ncxDir, src)
          if (!tocTitles.has(p)) tocTitles.set(p, clean(np.getElementsByTagNameNS('*', 'text')[0]?.textContent || ''))
        }
      }
    }
  } catch { /* оглавление необязательно */ }

  const docs: { path: string; body: Element }[] = []
  for (const idref of spine) {
    const item = manifest.get(idref)
    if (!item || !/html|xml/.test(item.type)) continue
    const path = resolvePath(dir, item.href)
    let html: string
    try { html = await read(path) } catch { continue }
    let doc = new DOMParser().parseFromString(html, 'application/xhtml+xml')
    if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(html, 'text/html')
    const body = doc.getElementsByTagName('body')[0]
    if (body) docs.push({ path, body })
  }
  // Цели ссылок-сносок: их содержимое — текст сносок, а не абзацы книги (часто лежат в отдельном файле).
  const ctx: HtmlCtx = { notes: {}, noteIds: new Set(), prefix: '' }
  for (const { body } of docs) {
    for (const a of Array.from(body.getElementsByTagName('a'))) {
      const href = a.getAttribute('href') || ''
      const type = a.getAttribute('epub:type') || a.getAttribute('role') || ''
      if (href.includes('#') && (/noteref/.test(type) || /^\[?\*?\d{1,3}\]?$|^\*+$/.test((a.textContent || '').trim()))) ctx.noteIds.add(href.split('#').pop()!)
    }
  }
  const chapters: Chapter[] = []
  for (const { path, body } of docs) {
    const blocks = blocksFromDom(body, ctx)
    if (blocks.length) chapters.push(chapterFromBlocks(blocks, tocTitles.get(path) || `Глава ${chapters.length + 1}`))
  }
  return finalizeBook(title, chapters, ctx.notes, author)
}

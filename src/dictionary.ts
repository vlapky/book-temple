import { local } from './storage'
import { setUserPronunciations } from './text/normalize'

/** Пользовательское произношение: слово → как читать («+» перед ударной гласной). */
export interface DictEntry { from: string; to: string }
export type DictScope = 'book' | 'global'

/** Ключ слова: без регистра, ё = е, без знаков ударения. */
export const dictKey = (w: string) => w.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC').toLowerCase().replace(/ё/g, 'е')

/** Слово: буквы и цифры, допускаются дефис и апостроф внутри. */
export const isDictWord = (w: string) => /^[\p{L}\p{N}]+(?:[-‐'’][\p{L}\p{N}]+)*$/u.test(w)
/** Произношение: кириллица, пробелы, дефис и «+» для ударения. */
export const isPronunciation = (s: string) => /^[а-яё+\s-]+$/i.test(s) && /[а-яё]/i.test(s)

class Dictionary {
  private bookId = ''
  private book: DictEntry[] = []
  private global: DictEntry[] = []
  private listeners: (() => void)[] = []

  constructor() {
    this.global = local.get<DictEntry[]>('dict:global', [])
  }

  load(bookId: string): void {
    this.bookId = bookId
    this.book = local.get<DictEntry[]>(`dict:${bookId}`, [])
    this.apply()
  }

  entries(scope: DictScope): DictEntry[] {
    return [...(scope === 'book' ? this.book : this.global)].sort((a, b) => a.from.localeCompare(b.from, 'ru'))
  }

  /** Добавить или заменить запись. */
  set(scope: DictScope, from: string, to: string): void {
    const list = scope === 'book' ? this.book : this.global
    const k = dictKey(from)
    const next = list.filter((e) => dictKey(e.from) !== k)
    next.push({ from: from.trim(), to: to.trim().replace(/\s+/g, ' ') })
    this.save(scope, next)
  }

  remove(scope: DictScope, from: string): void {
    const list = scope === 'book' ? this.book : this.global
    this.save(scope, list.filter((e) => dictKey(e.from) !== dictKey(from)))
  }

  private save(scope: DictScope, list: DictEntry[]): void {
    if (scope === 'book') { this.book = list; local.set(`dict:${this.bookId}`, list) }
    else { this.global = list; local.set('dict:global', list) }
    this.apply()
    for (const l of this.listeners) l()
  }

  /** Передать словарь синтезатору: записи книги важнее общих. */
  private apply(): void {
    const map = new Map<string, string>()
    for (const e of this.global) map.set(dictKey(e.from), e.to)
    for (const e of this.book) map.set(dictKey(e.from), e.to)
    setUserPronunciations(map)
  }

  on(l: () => void): void { this.listeners.push(l) }
}

export const dictionary = new Dictionary()

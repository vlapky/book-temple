export type BlockKind = 'p' | 'h' | 'quote' | 'verse' | 'sep'

/** Абзац книги. В тексте сноски обозначены маркером [[fn:id]]. */
export interface Block {
  k: BlockKind
  text: string
  /** Уровень заголовка внутри главы (1..4). */
  lvl?: number
}

export interface Chapter {
  title: string
  blocks: Block[]
  /** Число слов — для прогресса по книге. */
  words: number
}

export interface Book {
  id: string
  title: string
  author?: string
  chapters: Chapter[]
  /** Тексты сносок по id. */
  notes: Record<string, string>
  addedAt: number
}

export interface BookMeta {
  id: string
  title: string
  author?: string
  words: number
  addedAt: number
  openedAt: number
}

export interface Position {
  ch: number
  s: number
}

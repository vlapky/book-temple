// Подготовка текста для синтезатора: числа словами, латиница кириллицей, знаки ударения.

const ONES_M = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
const ONES_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать']
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто']
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот']
const SCALES: [string, string, string, boolean][] = [
  ['тысяча', 'тысячи', 'тысяч', true],
  ['миллион', 'миллиона', 'миллионов', false],
  ['миллиард', 'миллиарда', 'миллиардов', false],
  ['триллион', 'триллиона', 'триллионов', false],
]

function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10, h = n % 100
  if (h >= 11 && h <= 14) return many
  if (d === 1) return one
  if (d >= 2 && d <= 4) return few
  return many
}

function triad(n: number, fem: boolean): string[] {
  const out = [HUNDREDS[Math.floor(n / 100)]]
  const r = n % 100
  if (r >= 10 && r < 20) out.push(TEENS[r - 10])
  else out.push(TENS[Math.floor(r / 10)], (fem ? ONES_F : ONES_M)[r % 10])
  return out.filter(Boolean)
}

export function numberToWords(num: number): string {
  if (!Number.isFinite(num)) return ''
  if (num === 0) return 'ноль'
  const parts: string[] = []
  let n = Math.floor(Math.abs(num))
  const groups: number[] = []
  while (n > 0) { groups.push(n % 1000); n = Math.floor(n / 1000) }
  for (let g = groups.length - 1; g >= 0; g--) {
    const v = groups[g]
    if (!v) continue
    if (g === 0) parts.push(...triad(v, false))
    else {
      const sc = SCALES[g - 1]
      if (!sc) return String(num).split('').map((d) => ONES_M[+d] || 'ноль').join(' ')
      // «тысяча восемьсот», а не «одна тысяча восемьсот».
      parts.push(...(g === 1 && v === 1 ? [] : triad(v, sc[3])), plural(v, sc[0], sc[1], sc[2]))
    }
  }
  return (num < 0 ? 'минус ' : '') + parts.join(' ')
}

// Порядковые: «2-й», «1812-го» — читаем в именительном падеже мужского рода.
const ORD_ONES = ['', 'первый', 'второй', 'третий', 'четвёртый', 'пятый', 'шестой', 'седьмой', 'восьмой', 'девятый']
const ORD_TEENS = ['десятый', 'одиннадцатый', 'двенадцатый', 'тринадцатый', 'четырнадцатый', 'пятнадцатый', 'шестнадцатый', 'семнадцатый', 'восемнадцатый', 'девятнадцатый']
const ORD_TENS = ['', '', 'двадцатый', 'тридцатый', 'сороковой', 'пятидесятый', 'шестидесятый', 'семидесятый', 'восьмидесятый', 'девяностый']
const ORD_HUND = ['', 'сотый', 'двухсотый', 'трёхсотый', 'четырёхсотый', 'пятисотый', 'шестисотый', 'семисотый', 'восьмисотый', 'девятисотый']

export function ordinalToWords(num: number): string {
  const t = num % 1000
  // «тысячный» и большие порядковые — редкость, читаем количественным.
  if (num <= 0 || num >= 1_000_000 || t === 0) return numberToWords(num)
  const h = Math.floor(t / 100), r = t % 100
  const out: string[] = []
  if (num - t) out.push(numberToWords(num - t))
  if (r === 0) out.push(ORD_HUND[h])
  else {
    if (h) out.push(HUNDREDS[h])
    if (r < 10) out.push(ORD_ONES[r])
    else if (r < 20) out.push(ORD_TEENS[r - 10])
    else if (r % 10 === 0) out.push(ORD_TENS[r / 10])
    else out.push(TENS[Math.floor(r / 10)], ORD_ONES[r % 10])
  }
  return out.join(' ')
}

const LAT: Record<string, string> = {
  a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'дж', k: 'к', l: 'л', m: 'м',
  n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', y: 'й', z: 'з',
}
const LAT_PAIRS: [RegExp, string][] = [[/sh/g, 'ш'], [/ch/g, 'ч'], [/th/g, 'т'], [/ph/g, 'ф'], [/ee/g, 'и'], [/oo/g, 'у'], [/ck/g, 'к']]

function translit(w: string): string {
  let s = w.toLowerCase()
  for (const [re, r] of LAT_PAIRS) s = s.replace(re, r)
  return s.replace(/[a-z]/g, (c) => LAT[c] ?? '')
}

/** Как произнести слово. Результат — только кириллица, «+» (ударение) и дефис. */
export function spokenWord(w: string): string {
  let s = w.normalize('NFD')
    // Знак ударения после гласной → «+» перед ней (формат Vosk).
    .replace(/([аеёиоуыэюяАЕЁИОУЫЭЮЯ])́/g, '+$1')
    .normalize('NFC')
    .replace(/[̀-ͯ]/g, '')
  if (/\d/.test(s)) {
    const ord = /^(\d+)-?(й|я|е|го|му|м|х|ю|ая|ое|ые|ый|ой|ий|ого|ому|ым|ых)$/.exec(s)
    if (ord) return ordinalToWords(+ord[1])
    s = s.replace(/(\d+)[.,](\d+)/g, (_, a, b) => `${numberToWords(+a)} целых ${numberToWords(+b)}`)
    s = s.replace(/\d+/g, (d) => (d.length > 15 ? d.split('').map((x) => numberToWords(+x)).join(' ') : numberToWords(+d)))
    s = s.replace(/(\p{L})(\s*)-(\s*)(\p{L})/gu, '$1 $4').trim()
  }
  if (/[a-z]/i.test(s)) s = s.replace(/[a-z]+/gi, translit)
  s = s.replace(/[’']/g, '').replace(/[^а-яё+\- ]/gi, '')
  return s || ''
}

/** Пунктуация между словами в формате, понятном синтезатору. */
export function ttsPunct(v: string): string {
  return v
    .replace(/[«»“”„"]/g, '"')
    .replace(/[—–‐]/g, ' - ')
    .replace(/…/g, '...')
    .replace(/[[\]{}]/g, ' ')
    .replace(/[^\s,.?!;:"()-]/g, ' ')
}

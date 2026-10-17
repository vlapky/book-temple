import { dictionary, isDictWord, isPronunciation, type DictScope } from '../dictionary'
import { showDialog } from './dialog'
import { esc } from './dom'
import { icon } from './icons'

/** Окно «Словарь произношения»: как голос должен читать отдельные слова. */
export function dictionaryDialog(bookTitle: string, preview: (text: string) => void): Promise<unknown> {
  return showDialog(`
    <h2 id="dlgTitle">Словарь произношения</h2>
    <p class="hint">Если голос читает слово неправильно, напишите, как его произносить. Ударение — знак «+» перед гласной: зам+ок, д+ома.</p>
    <form class="dict-form" id="dictForm" novalidate>
      <label class="dict-field"><span>Слово в тексте</span><input class="text-input" id="dictFrom" autocomplete="off" spellcheck="false" placeholder="Например, Leica" autofocus /></label>
      <label class="dict-field"><span>Как читать</span><input class="text-input" id="dictTo" autocomplete="off" spellcheck="false" placeholder="л+ейка" /></label>
      <fieldset class="dict-scope">
        <legend class="sr-only">Где действует</legend>
        <div class="seg">
          <label><input type="radio" name="dictScope" value="book" checked />Эта книга</label>
          <label><input type="radio" name="dictScope" value="global" />Все книги</label>
        </div>
      </fieldset>
      <p class="dict-error" id="dictError" role="alert"></p>
      <div class="btn-row">
        <button type="button" class="btn" id="dictPreview">${icon('speaker')}Прослушать</button>
        <button type="submit" class="btn primary">Добавить</button>
      </div>
    </form>
    <div id="dictLists"></div>
    <div class="actions"><button type="button" class="btn" data-value="close">Готово</button></div>`, (d) => {
    const form = d.querySelector<HTMLFormElement>('#dictForm')!
    const from = d.querySelector<HTMLInputElement>('#dictFrom')!
    const to = d.querySelector<HTMLInputElement>('#dictTo')!
    const err = d.querySelector<HTMLElement>('#dictError')!
    const lists = d.querySelector<HTMLElement>('#dictLists')!
    const scope = () => (d.querySelector<HTMLInputElement>('input[name="dictScope"]:checked')!.value as DictScope)

    const render = () => {
      const section = (sc: DictScope, title: string) => {
        const items = dictionary.entries(sc)
        return `<section class="dict-list" aria-label="${esc(title)}">
          <h3 class="group-title">${esc(title)} <span class="item-sub">${items.length || ''}</span></h3>
          ${items.length ? `<ul class="list">${items.map((e) => `
            <li class="item dict-item">
              <span class="dict-from">${esc(e.from)}</span>
              <span class="dict-to">${esc(e.to)}</span>
              <button type="button" class="pbtn small" data-say="${esc(e.to)}" aria-label="Прослушать «${esc(e.to)}»">${icon('speaker')}</button>
              <button type="button" class="pbtn small" data-del="${esc(e.from)}" data-scope="${sc}" aria-label="Удалить «${esc(e.from)}»">${icon('trash')}</button>
            </li>`).join('')}</ul>` : '<p class="empty">Пока пусто.</p>'}
        </section>`
      }
      lists.innerHTML = section('book', `Эта книга: «${bookTitle}»`) + section('global', 'Все книги')
    }

    const check = (): string | null => {
      const f = from.value.trim(), t = to.value.trim()
      if (!f) return 'Введите слово, которое голос читает неправильно.'
      if (!isDictWord(f)) return 'Только одно слово, без пробелов и знаков препинания.'
      if (!t) return 'Напишите, как произносить слово.'
      if (!isPronunciation(t)) return 'Произношение пишется русскими буквами; ударение — знак «+».'
      return null
    }

    form.onsubmit = (e) => {
      e.preventDefault()
      const problem = check()
      err.textContent = problem ?? ''
      if (problem) return
      dictionary.set(scope(), from.value, to.value)
      from.value = ''
      to.value = ''
      render()
      from.focus()
    }
    // Enter в первом поле переходит ко второму, а не отправляет форму.
    from.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); to.focus() } }
    d.querySelector<HTMLButtonElement>('#dictPreview')!.onclick = () => {
      const t = to.value.trim()
      if (!t || !isPronunciation(t)) { err.textContent = 'Сначала напишите, как произносить слово.'; return }
      err.textContent = ''
      preview(t)
    }
    lists.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button')
      if (!b) return
      if (b.dataset.say) preview(b.dataset.say)
      else if (b.dataset.del) { dictionary.remove(b.dataset.scope as DictScope, b.dataset.del); render(); from.focus() }
    }
    render()
  })
}

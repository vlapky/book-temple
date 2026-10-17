/**
 * Выпадающее меню по шаблону WAI-ARIA Menu Button:
 * стрелки — по пунктам, Home/End — к краям, Esc — закрыть и вернуть фокус на кнопку.
 */
export function setupMenu(button: HTMLElement, menu: HTMLElement, onAction: (action: string) => void): void {
  const items = () => Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'))

  const open = (focus: 'first' | 'last' = 'first') => {
    menu.hidden = false
    button.setAttribute('aria-expanded', 'true')
    const list = items()
    // preventScroll: иначе браузер подкручивает страницу к пункту меню в «липкой» шапке.
    ;(focus === 'first' ? list[0] : list[list.length - 1])?.focus({ preventScroll: true })
  }
  const close = (returnFocus = true) => {
    if (menu.hidden) return
    menu.hidden = true
    button.setAttribute('aria-expanded', 'false')
    if (returnFocus) button.focus({ preventScroll: true })
  }

  button.addEventListener('click', () => (menu.hidden ? open() : close()))
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); open('first') }
    else if (e.key === 'ArrowUp') { e.preventDefault(); open('last') }
  })

  menu.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')
    if (!item) return
    close(false)
    onAction(item.dataset.action!)
  })

  menu.addEventListener('keydown', (e) => {
    const list = items()
    const i = list.indexOf(document.activeElement as HTMLElement)
    const go = (n: number) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus({ preventScroll: true }) }
    switch (e.key) {
      case 'ArrowDown': go(i + 1); break
      case 'ArrowUp': go(i - 1); break
      case 'Home': go(0); break
      case 'End': go(list.length - 1); break
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(); break
      case 'Tab': close(false); break
      default:
        // Буквенные горячие клавиши не должны срабатывать, пока открыто меню.
        if (e.key.length === 1 && e.key !== ' ') e.stopPropagation()
    }
  })

  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node) && !button.contains(e.target as Node)) close(false)
  })
}

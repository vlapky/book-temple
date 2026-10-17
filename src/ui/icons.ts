// Простые контурные иконки 24×24. Цвет — currentColor.
const P: Record<string, string> = {
  library: '<path d="M4 4h4v16H4zM10 4h4v16h-4z"/><path d="m16.5 4.5 3.8 1-3.9 14.6-3.8-1z"/>',
  open: '<path d="M4 20V6a2 2 0 0 1 2-2h5l2 2h5a2 2 0 0 1 2 2v2"/><path d="M4 20l3-8h15l-3 8z"/>',
  toc: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  bookmark: '<path d="M6 3h12v18l-6-4.5L6 21z"/>',
  bookmarkFilled: '<path d="M6 3h12v18l-6-4.5L6 21z" fill="currentColor"/>',
  note: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  focus: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/><circle cx="12" cy="12" r="2.5"/>',
  rsvp: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.5"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke-linejoin="round"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/>',
  prev: '<path d="M18 5v14l-9-7z" fill="currentColor"/><path d="M6 5v14"/>',
  next: '<path d="M6 5v14l9-7z" fill="currentColor"/><path d="M18 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>',
  speaker: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  ruler: '<path d="M3 9h18v6H3z"/><path d="M7 9v3M11 9v3M15 9v3M19 9v3" />',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  logo: '<path d="M3 6.5C6 5 9 5 12 7c3-2 6-2 9-.5V19c-3-1.5-6-1.5-9 .5-3-2-6-2-9-.5z"/><path d="M12 7v12.5"/>',
}

export function icon(name: string, cls = 'ico'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name] ?? ''}</svg>`
}

/** Вставляет иконки в элементы с атрибутом data-icon. */
export function hydrateIcons(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    if (el.querySelector(':scope > svg.ico')) continue
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon!))
  }
}

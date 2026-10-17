// Service worker Комфорт ридера. Шаблон: версия и список файлов подставляются при сборке (vite.config.ts).
const VERSION = '__VERSION__'
const SHELL = `shell-${VERSION}`
const RUNTIME = 'runtime-v1'
const PRECACHE = __PRECACHE__

const scope = new URL(self.registration.scope)
const toUrl = (p) => new URL(p, scope).href

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE.map(toUrl))).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('shell-') && k !== SHELL) await caches.delete(k)
    await self.clients.claim()
  })())
})

// Заголовки изоляции: без них не работает многопоточный WASM у синтезатора речи.
function isolate(resp) {
  if (!resp || resp.type === 'opaque' || resp.status === 0) return resp
  const h = new Headers(resp.headers)
  h.set('Cross-Origin-Opener-Policy', 'same-origin')
  h.set('Cross-Origin-Embedder-Policy', 'require-corp')
  h.set('Cross-Origin-Resource-Policy', 'same-origin')
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h })
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin) return // модель TTS кэширует сама библиотека (IndexedDB)

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const net = await fetch(req)
        const c = await caches.open(SHELL)
        c.put(toUrl('index.html'), net.clone())
        return isolate(net)
      } catch {
        return isolate((await caches.match(toUrl('index.html'), { ignoreVary: true })) || (await caches.match(toUrl(''), { ignoreVary: true })))
      }
    })())
    return
  }

  e.respondWith((async () => {
    // ignoreVary: серверы часто отдают Vary: Origin, а модульные скрипты запрашиваются с Origin.
    const hit = await caches.match(req, { ignoreSearch: true, ignoreVary: true })
    if (hit) return isolate(hit)
    const net = await fetch(req)
    if (net.ok) (await caches.open(RUNTIME)).put(req, net.clone())
    return isolate(net)
  })())
})

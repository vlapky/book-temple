import { defineConfig, type Plugin, type ResolvedConfig } from 'vite'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = (p: string) => resolve(fileURLToPath(new URL('.', import.meta.url)), p)

// COOP/COEP нужны для многопоточного WASM (SharedArrayBuffer) в синтезаторе речи.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

/** Копирует ort-wasm-* из onnxruntime-web в public/ort, чтобы рантайм грузился с нашего origin (и работал офлайн). */
function ortWasm(): Plugin {
  const copy = () => {
    const src = here('node_modules/onnxruntime-web/dist')
    const dst = here('public/ort')
    mkdirSync(dst, { recursive: true })
    for (const f of readdirSync(src)) {
      if (!/^ort-wasm-simd-threaded(\.jsep|\.asyncify)?\.(wasm|mjs)$/.test(f)) continue
      const from = join(src, f), to = join(dst, f)
      if (existsSync(to) && statSync(to).size === statSync(from).size) continue
      copyFileSync(from, to)
    }
  }
  // config() — до того, как dev-сервер составит список файлов public/.
  return { name: 'ort-wasm', config: () => { copy() } }
}

/** Генерирует sw.js со списком файлов оболочки приложения для предзагрузки в кэш. */
function serviceWorker(): Plugin {
  let config: ResolvedConfig
  return {
    name: 'service-worker',
    apply: 'build',
    configResolved(c) { config = c },
    generateBundle(_, bundle) {
      const files = new Set<string>(['', 'index.html'])
      for (const [name, item] of Object.entries(bundle)) {
        if (name.endsWith('.map') || name.endsWith('.woff')) continue
        // Шрифты: только кириллица и латиница, остальное подгрузится по требованию.
        if (name.endsWith('.woff2') && !/-(cyrillic|latin)-\d/.test(name)) continue
        const size = item.type === 'asset' ? (typeof item.source === 'string' ? item.source.length : item.source.byteLength) : item.code.length
        if (size > 3_000_000) continue
        files.add(name)
      }
      const pub = config.publicDir
      const walk = (dir: string, rel = '') => {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f), r = rel + f
          if (statSync(p).isDirectory()) { if (f !== 'ort') walk(p, r + '/') } else files.add(r)
        }
      }
      if (pub && existsSync(pub)) walk(pub)
      const list = [...files].sort()
      const version = createHash('sha1').update(list.join('|') + Date.now()).digest('hex').slice(0, 10)
      const tpl = readFileSync(here('pwa/sw.js'), 'utf8')
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: tpl.replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(list)),
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [ortWasm(), serviceWorker()],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['vosk-tts-web', 'onnxruntime-web'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
})

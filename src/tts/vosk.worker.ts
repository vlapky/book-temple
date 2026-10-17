/// <reference lib="webworker" />
// Синтез речи Vosk в отдельном потоке, чтобы интерфейс не подвисал.
import { VoskTTS } from 'vosk-tts-web'

export type WorkerIn =
  | { type: 'init'; backend: 'auto' | 'webgpu' | 'wasm'; wasmPaths: string; threads: number }
  | { type: 'synth'; id: number; text: string; speaker: number; speechRate: number; noise: number }

export type WorkerOut =
  | { type: 'progress'; overall: number; file: string; cached?: boolean }
  | { type: 'ready'; backend: string }
  | { type: 'audio'; id: number; audio: Int16Array; sampleRate: number }
  | { type: 'error'; id?: number; message: string }

let tts: VoskTTS | null = null
const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer)

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const m = e.data
  if (m.type === 'init') {
    try {
      tts = await VoskTTS.create({
        backend: m.backend,
        threads: m.threads,
        wasmPaths: m.wasmPaths,
        onProgress: (p) => post({ type: 'progress', overall: p.overall, file: p.file, cached: p.cached }),
      })
      post({ type: 'ready', backend: tts.backend ?? 'wasm' })
    } catch (err) {
      post({ type: 'error', message: String((err as Error)?.message ?? err) })
    }
    return
  }
  if (m.type === 'synth') {
    if (!tts) { post({ type: 'error', id: m.id, message: 'Модель не загружена' }); return }
    try {
      const r = await tts.synth(m.text, { speaker: m.speaker, speechRate: m.speechRate, noise: m.noise, durNoise: m.noise })
      post({ type: 'audio', id: m.id, audio: r.audio, sampleRate: r.sampleRate }, [r.audio.buffer])
    } catch (err) {
      post({ type: 'error', id: m.id, message: String((err as Error)?.message ?? err) })
    }
  }
}

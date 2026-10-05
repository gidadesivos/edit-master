/// <reference lib="webworker" />
/**
 * Speech-to-text with Whisper running on this computer (transformers.js / ONNX Runtime).
 * The model is downloaded once from Hugging Face and cached by the browser; audio never leaves the machine.
 */
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

export interface CaptionRequest {
  type: 'transcribe';
  audio: Float32Array; // 16 kHz mono
  model: string;
  language: string | null;
}

export type CaptionMessage =
  | { type: 'progress'; stage: 'download' | 'load' | 'transcribe'; progress: number | null; detail?: string }
  | { type: 'result'; chunks: Array<{ start: number; end: number; text: string }>; device: string }
  | { type: 'error'; message: string };

env.allowLocalModels = false;
env.useBrowserCache = true;

const post = (m: CaptionMessage) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);
const cache = new Map<string, Promise<{ asr: AutomaticSpeechRecognitionPipeline; device: string }>>();

async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!gpu && !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

function load(model: string) {
  let p = cache.get(model);
  if (!p) {
    p = (async () => {
      const files = new Map<string, { loaded: number; total: number }>();
      const progress_callback = (e: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (e.status === 'progress' && e.file && e.total) {
          files.set(e.file, { loaded: e.loaded ?? 0, total: e.total });
          let loaded = 0;
          let total = 0;
          for (const f of files.values()) {
            loaded += f.loaded;
            total += f.total;
          }
          post({ type: 'progress', stage: 'download', progress: total ? loaded / total : null, detail: `${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB` });
        } else if (e.status === 'ready') {
          post({ type: 'progress', stage: 'load', progress: null });
        }
      };
      const gpu = await hasWebGpu();
      const make = (device: 'webgpu' | 'wasm') =>
        pipeline('automatic-speech-recognition', model, {
          device,
          dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
          progress_callback,
        }) as Promise<AutomaticSpeechRecognitionPipeline>;
      if (gpu) {
        try {
          return { asr: await make('webgpu'), device: 'webgpu' };
        } catch (err) {
          console.warn('WebGPU unavailable for Whisper, falling back to WASM', err);
        }
      }
      return { asr: await make('wasm'), device: 'wasm' };
    })();
    p.catch(() => cache.delete(model));
    cache.set(model, p);
  }
  return p;
}

self.onmessage = async (ev: MessageEvent<CaptionRequest>) => {
  const req = ev.data;
  if (req.type !== 'transcribe') return;
  try {
    post({ type: 'progress', stage: 'download', progress: null });
    const { asr, device } = await load(req.model);
    post({ type: 'progress', stage: 'transcribe', progress: null });
    const out = await asr(req.audio, {
      language: req.language ?? undefined,
      task: 'transcribe',
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    type Out = { text?: string; chunks?: Array<{ timestamp: [number | null, number | null]; text: string }> };
    const result = (Array.isArray(out) ? out[0] : out) as Out;
    const total = req.audio.length / 16000;
    const chunks = (result.chunks ?? [])
      .map((c) => ({ start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? total, text: c.text.trim() }))
      .filter((c) => c.text);
    if (!chunks.length && result.text?.trim()) chunks.push({ start: 0, end: total, text: result.text.trim() });
    post({ type: 'result', chunks, device });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

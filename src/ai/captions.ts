/** Automatic captions: mixes the timeline audio to 16 kHz mono and runs Whisper in a worker. */
import { projectDuration } from '../engine/project';
import type { SpeechSegment } from '../engine/captions';
import type { Project } from '../engine/types';
import { createAudioMixer } from '../render/audioMix';
import type { CaptionMessage, CaptionRequest } from './captionWorker';

export const CAPTION_MODELS = [
  { id: 'onnx-community/whisper-tiny', label: 'Rápido', size: '~40 MB' },
  { id: 'onnx-community/whisper-base', label: 'Equilibrado', size: '~80 MB' },
  { id: 'onnx-community/whisper-small', label: 'Preciso', size: '~250 MB' },
] as const;

export const CAPTION_LANGUAGES = [
  { code: 'portuguese', label: 'Português' },
  { code: 'english', label: 'Inglês' },
  { code: 'spanish', label: 'Espanhol' },
  { code: null, label: 'Detectar automaticamente' },
] as const;

export interface CaptionProgress {
  stage: 'audio' | 'download' | 'load' | 'transcribe';
  progress: number | null;
  detail?: string;
}

export class CaptionsCanceledError extends Error {}

const SAMPLE_RATE = 16_000;

/** Renders the audible timeline to a mono 16 kHz signal (what Whisper expects). */
export async function timelineAudio16k(project: Project, onProgress: (p: CaptionProgress) => void, signal: AbortSignal): Promise<Float32Array> {
  const duration = projectDuration(project);
  const out = new Float32Array(Math.ceil(duration * SAMPLE_RATE));
  const mixer = createAudioMixer(project, SAMPLE_RATE, 1);
  try {
    const WINDOW = 10;
    for (let t = 0; t < duration; t += WINDOW) {
      if (signal.aborted) throw new CaptionsCanceledError('Cancelado');
      const end = Math.min(duration, t + WINDOW);
      const buf = await mixer.mix(t, end);
      out.set(buf.getChannelData(0).subarray(0, out.length - Math.round(t * SAMPLE_RATE)), Math.round(t * SAMPLE_RATE));
      onProgress({ stage: 'audio', progress: end / duration });
    }
  } finally {
    await mixer.dispose();
  }
  return out;
}

let worker: Worker | null = null;
function getWorker(): Worker {
  if (!worker) worker = new Worker(new URL('./captionWorker.ts', import.meta.url), { type: 'module' });
  return worker;
}

export async function transcribe(
  audio: Float32Array,
  model: string,
  language: string | null,
  onProgress: (p: CaptionProgress) => void,
  signal: AbortSignal,
): Promise<SpeechSegment[]> {
  const w = getWorker();
  return new Promise<SpeechSegment[]>((resolve, reject) => {
    const cleanup = () => {
      w.removeEventListener('message', onMessage);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      // The only way to stop a running inference is to terminate the worker; the cached model stays on disk.
      w.terminate();
      worker = null;
      reject(new CaptionsCanceledError('Cancelado'));
    };
    const onMessage = (ev: MessageEvent<CaptionMessage>) => {
      const m = ev.data;
      if (m.type === 'progress') onProgress({ stage: m.stage, progress: m.progress, detail: m.detail });
      else if (m.type === 'result') {
        cleanup();
        resolve(m.chunks);
      } else if (m.type === 'error') {
        cleanup();
        reject(new Error(m.message));
      }
    };
    w.addEventListener('message', onMessage);
    signal.addEventListener('abort', onAbort);
    const req: CaptionRequest = { type: 'transcribe', audio, model, language };
    w.postMessage(req, [audio.buffer]);
  });
}

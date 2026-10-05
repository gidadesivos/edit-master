/**
 * Offline export: decodes every frame precisely (WebCodecs via Mediabunny), composites it with the
 * shared compositor, mixes audio with an OfflineAudioContext and encodes an MP4 — all locally.
 */
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  StreamTarget,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type StreamTargetChunk,
  type WrappedCanvas,
} from 'mediabunny';
import { clipEnd, projectDuration } from '../engine/project';
import type { Clip, Project, Seconds } from '../engine/types';
import { getMediaFile } from '../media/library';
import { createAudioMixer, type AssetReader } from './audioMix';
import { ensureSegmenter, resetEffectsState } from './effects';
import { openInput } from '../media/probe';
import type { SaveTarget } from '../platform/fs';
import {
  frameItems,
  isAudibleClip,
  renderFrame,
  sourceTimeExtended,
  visualEnd,
  type FrameSource,
} from './compositor';

export type ExportQuality = 'medium' | 'high' | 'very-high';

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  quality: ExportQuality;
  target: SaveTarget;
  signal: AbortSignal;
  onProgress: (fraction: number, info: string) => void;
}

export interface ExportResult {
  /** Present when the output was rendered in memory (no direct file access). */
  blob: Blob | null;
  videoCodec: string;
  audioCodec: string | null;
}

export class ExportCanceledError extends Error {}

const SAMPLE_RATE = 48_000;
const AUDIO_WINDOW = 1; // seconds of audio mixed per step

const QUALITY = { medium: QUALITY_MEDIUM, high: QUALITY_HIGH, 'very-high': QUALITY_VERY_HIGH } as const;

interface VideoCursor {
  iterator: AsyncGenerator<WrappedCanvas | null, void, unknown>;
  last: WrappedCanvas | null;
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

export async function exportProject(project: Project, opts: ExportOptions): Promise<ExportResult> {
  const duration = projectDuration(project);
  if (duration <= 0) throw new Error('A timeline está vazia. Adicione clipes antes de exportar.');

  const missing = Object.values(project.clips).filter((c) => c.kind === 'media' && !getMediaFile(c.assetId));
  if (missing.length) throw new Error('Há mídias offline na timeline. Reconecte os arquivos antes de exportar.');

  if (Object.values(project.clips).some((c) => c.removeBg)) {
    opts.onProgress(0, 'Carregando o recorte de fundo…');
    try {
      await ensureSegmenter();
    } catch {
      throw new Error('Não foi possível iniciar a remoção de fundo neste computador.');
    }
  }
  resetEffectsState();

  const width = even(opts.width);
  const height = even(opts.height);
  const fps = opts.fps;
  const quality = QUALITY[opts.quality];

  const format = new Mp4OutputFormat(opts.target.writable ? { fastStart: false } : { fastStart: 'in-memory' });

  const videoCodec = await getFirstEncodableVideoCodec(
    format.getSupportedVideoCodecs().filter((c) => ['avc', 'hevc', 'vp9', 'av1'].includes(c)),
    { width, height, quality },
  );
  if (!videoCodec) throw new Error('Este computador não consegue codificar vídeo nesta resolução. Tente uma resolução menor.');

  const hasAudio = Object.values(project.clips).some((c) => isAudibleClip(project, c));
  const audioCodec = hasAudio
    ? await getFirstEncodableAudioCodec(
        format.getSupportedAudioCodecs().filter((c) => ['aac', 'opus'].includes(c)),
        { numberOfChannels: 2, sampleRate: SAMPLE_RATE, quality },
      )
    : null;

  const target = opts.target.writable
    ? new StreamTarget(
        new WritableStream<StreamTargetChunk>({
          write: (chunk) => opts.target.writable!.write({ type: 'write', position: chunk.position, data: chunk.data }),
        }),
        { chunked: true },
      )
    : new BufferTarget();

  const output = new Output({ format, target });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas indisponível');

  const videoSource = new CanvasSource(canvas, { codec: videoCodec, quality, keyFrameInterval: 2 });
  output.addVideoTrack(videoSource, { frameRate: fps });
  const audioSource = audioCodec ? new AudioBufferSource({ codec: audioCodec, quality }) : null;
  if (audioSource) output.addAudioTrack(audioSource);

  const readers = new Map<string, AssetReader>();
  const cursors = new Map<string, VideoCursor>();
  const images = new Map<string, ImageBitmap>();

  const reader = async (assetId: string): Promise<AssetReader> => {
    let r = readers.get(assetId);
    if (!r) {
      const input = openInput(getMediaFile(assetId)!);
      r = { input, first: Math.max(0, await input.getFirstTimestamp()) };
      readers.set(assetId, r);
    }
    return r;
  };


  const totalFrames = Math.max(1, Math.ceil(duration * fps - 1e-6));
  let audioDone = 0;

  const openCursor = async (clip: Clip, fromFrame: number): Promise<VideoCursor | null> => {
    const r = await reader(clip.assetId);
    const track = await r.input.getPrimaryVideoTrack();
    if (!track) return null;
    const sink = new CanvasSink(track, { poolSize: 3 });
    // Includes the transition tail, during which the clip keeps playing past its out-point.
    const lastFrame = Math.ceil(visualEnd(project, clip) * fps - 1e-6);
    const end = clipEnd(clip);
    function* times() {
      for (let f = fromFrame; f < lastFrame; f++) {
        const t = f / fps;
        if (t < end) {
          const local = Math.max(0, t - clip.start);
          yield r.first + clip.in + Math.min(local * clip.speed, clip.out - clip.in - 1e-4);
        } else {
          yield r.first + sourceTimeExtended(project, clip, t);
        }
      }
    }
    return { iterator: sink.canvasesAtTimestamps(times()), last: null };
  };

  const closeCursor = async (id: string) => {
    const c = cursors.get(id);
    if (c) {
      cursors.delete(id);
      await c.iterator.return(undefined);
    }
  };

  const mixer = createAudioMixer(project, SAMPLE_RATE, 2, reader);
  const mixAudio = (t0: Seconds, t1: Seconds) => mixer.mix(t0, t1);

  try {
    await output.start();

    for (let f = 0; f < totalFrames; f++) {
      if (opts.signal.aborted) throw new ExportCanceledError('Exportação cancelada');
      const t = f / fps;

      // Keep audio slightly ahead of video so the muxer can interleave without buffering everything.
      if (audioSource) {
        while (audioDone < Math.min(duration, t + AUDIO_WINDOW)) {
          const next = Math.min(duration, audioDone + AUDIO_WINDOW);
          await audioSource.add(await mixAudio(audioDone, next));
          audioDone = next;
        }
      }

      // Fetch every picture this frame needs (decoding is async), then composite synchronously.
      const items = frameItems(project, t);
      const activeIds = new Set(items.map((i) => i.clip.id));
      for (const id of [...cursors.keys()]) if (!activeIds.has(id)) await closeCursor(id);
      const frames = new Map<string, FrameSource>();
      for (const { clip } of items) {
        if (clip.kind !== 'media' || frames.has(clip.id)) continue;
        const asset = project.assets[clip.assetId];
        if (!asset) continue;
        if (asset.kind === 'image') {
          let bmp = images.get(asset.id);
          if (!bmp) {
            bmp = await createImageBitmap(getMediaFile(asset.id)!);
            images.set(asset.id, bmp);
          }
          frames.set(clip.id, { source: bmp, width: bmp.width, height: bmp.height });
          continue;
        }
        let cursor = cursors.get(clip.id);
        if (!cursor) {
          const opened = await openCursor(clip, f);
          if (!opened) continue;
          cursor = opened;
          cursors.set(clip.id, cursor);
        }
        const next = await cursor.iterator.next();
        if (!next.done && next.value) cursor.last = next.value;
        if (cursor.last) {
          const c = cursor.last.canvas;
          frames.set(clip.id, { source: c, width: c.width, height: c.height });
        }
      }
      renderFrame(ctx, project, t, width, height, (clip) => frames.get(clip.id) ?? null);
      await videoSource.add(t, 1 / fps);
      if (f % 5 === 0) opts.onProgress(f / totalFrames, `Quadro ${f + 1} de ${totalFrames}`);
    }

    if (audioSource) {
      while (audioDone < duration - 1e-6) {
        const next = Math.min(duration, audioDone + AUDIO_WINDOW);
        await audioSource.add(await mixAudio(audioDone, next));
        audioDone = next;
      }
    }

    opts.onProgress(1, 'Finalizando arquivo…');
    await output.finalize();
    if (opts.target.writable) await opts.target.writable.close();

    const blob =
      target instanceof BufferTarget && target.buffer ? new Blob([target.buffer], { type: format.mimeType }) : null;
    return { blob, videoCodec, audioCodec };
  } catch (err) {
    await output.cancel().catch(() => undefined);
    await opts.target.writable?.abort?.().catch(() => undefined);
    throw err;
  } finally {
    for (const id of [...cursors.keys()]) await closeCursor(id).catch(() => undefined);
    await mixer.dispose().catch(() => undefined);
    for (const r of readers.values()) r.input.dispose();
    for (const b of images.values()) b.close();
  }
}

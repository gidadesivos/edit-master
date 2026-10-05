/**
 * Offline export: decodes every frame precisely (WebCodecs via Mediabunny), composites it with the
 * shared compositor, mixes audio with an OfflineAudioContext and encodes an MP4 — all locally.
 */
import {
  AudioBufferSink,
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
  type Input,
  type StreamTargetChunk,
  type WrappedAudioBuffer,
  type WrappedCanvas,
} from 'mediabunny';
import { clipEnd, projectDuration } from '../engine/project';
import type { Clip, Project, Seconds } from '../engine/types';
import { getMediaFile } from '../media/library';
import { openInput } from '../media/probe';
import type { SaveTarget } from '../platform/fs';
import {
  clipGainAt,
  frameItems,
  isAudibleClip,
  renderFrame,
  sourceTimeExtended,
  trackMap,
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

interface AssetReader {
  input: Input;
  first: number;
}

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

  const tracks = trackMap(project);
  const clips = Object.values(project.clips);
  const audible = clips.filter((c) => isAudibleClip(project, c));

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

  /**
   * One continuous decoder per audio clip across all mixing windows. Restarting a decoder for every
   * window shifts some codecs (e.g. Opus) by their pre-skip and produces audible clicks.
   */
  interface AudioCursor {
    iterator: AsyncGenerator<WrappedAudioBuffer, void, unknown>;
    /** Decoded buffers that still overlap the current or future windows. */
    pending: Array<{ buffer: AudioBuffer; pos: Seconds; end: Seconds }>;
    done: boolean;
  }
  const audioCursors = new Map<string, AudioCursor | null>();

  const audioCursor = async (clip: Clip): Promise<AudioCursor | null> => {
    if (audioCursors.has(clip.id)) return audioCursors.get(clip.id)!;
    const r = await reader(clip.assetId);
    const track = await r.input.getPrimaryAudioTrack();
    const cursor = track
      ? {
          iterator: new AudioBufferSink(track).buffers(Math.max(0, r.first + clip.in - 0.05), r.first + clip.out),
          pending: [],
          done: false,
        }
      : null;
    audioCursors.set(clip.id, cursor);
    return cursor;
  };

  const mixAudio = async (t0: Seconds, t1: Seconds): Promise<AudioBuffer> => {
    const length = Math.max(1, Math.round((t1 - t0) * SAMPLE_RATE));
    const ac = new OfflineAudioContext(2, length, SAMPLE_RATE);
    for (const clip of audible) {
      const end = clipEnd(clip);
      if (end <= t0 || clip.start >= t1) continue;
      const cursor = await audioCursor(clip);
      if (!cursor) continue;
      const r = readers.get(clip.assetId)!;

      // Decode until we have audio covering the whole window.
      while (!cursor.done && (!cursor.pending.length || cursor.pending[cursor.pending.length - 1].end < t1)) {
        const next = await cursor.iterator.next();
        if (next.done) {
          cursor.done = true;
          break;
        }
        const { buffer, timestamp } = next.value;
        const pos = clip.start + (timestamp - r.first - clip.in) / clip.speed;
        cursor.pending.push({ buffer, pos, end: pos + buffer.duration / clip.speed });
      }

      const gain = ac.createGain();
      gain.connect(ac.destination);
      const tr = tracks.get(clip.trackId);
      const keyTimes = [t0, clip.start + clip.fadeIn, end - clip.fadeOut, t1]
        .filter((x) => x >= t0 && x <= t1)
        .sort((a, b) => a - b);
      // Evaluate inside the clip: outside it the gain is 0, which must not bleed into ramps.
      const g = (k: Seconds) => clipGainAt(clip, tr, Math.min(Math.max(k, clip.start), end - 1e-6));
      gain.gain.setValueAtTime(g(t0), 0);
      for (const k of keyTimes.slice(1)) gain.gain.linearRampToValueAtTime(g(k), k - t0);

      const from = Math.max(t0, clip.start);
      const to = Math.min(t1, end);
      for (const item of cursor.pending) {
        if (item.end <= from || item.pos >= to) continue;
        let pos = item.pos;
        let offset = 0;
        if (pos < from) {
          offset = (from - pos) * clip.speed;
          pos = from;
        }
        const length = Math.min(item.buffer.duration - offset, (to - pos) * clip.speed);
        if (length <= 0) continue;
        const node = ac.createBufferSource();
        node.buffer = item.buffer;
        node.playbackRate.value = clip.speed;
        node.connect(gain);
        node.start(pos - t0, offset, length);
      }
      // Buffers entirely before the next window are no longer needed.
      cursor.pending = cursor.pending.filter((item) => item.end > t1);
    }
    return ac.startRendering();
  };

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
    for (const c of audioCursors.values()) await c?.iterator.return(undefined).catch(() => undefined);
    for (const r of readers.values()) r.input.dispose();
    for (const b of images.values()) b.close();
  }
}

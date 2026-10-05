/**
 * Shared frame compositor. Both the live preview and the final export call these functions,
 * so what you see in the editor is exactly what ends up in the exported file.
 */
import { clipDuration, clipEnd } from '../engine/project';
import type { Clip, Project, Seconds, Track } from '../engine/types';

export interface Layer {
  clip: Clip;
  source: CanvasImageSource;
  width: number;
  height: number;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawLayer(ctx: Ctx2D, layer: Layer, canvasW: number, canvasH: number): void {
  const { clip, source, width, height } = layer;
  if (width <= 0 || height <= 0 || clip.opacity <= 0) return;
  const t = clip.transform;
  const fit = Math.min(canvasW / width, canvasH / height) * t.scale;
  const w = width * fit;
  const h = height * fit;
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0, clip.opacity));
  ctx.translate(canvasW / 2 + t.x * canvasW, canvasH / 2 + t.y * canvasH);
  if (t.rotation) ctx.rotate((t.rotation * Math.PI) / 180);
  ctx.drawImage(source, -w / 2, -h / 2, w, h);
  ctx.restore();
}

export function drawFrame(ctx: Ctx2D, background: string, layers: Layer[], canvasW: number, canvasH: number): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvasW, canvasH);
  ctx.imageSmoothingQuality = 'high';
  ctx.restore();
  for (const layer of layers) drawLayer(ctx, layer, canvasW, canvasH);
}

/** Position inside the source media for a timeline time. */
export function sourceTime(clip: Clip, t: Seconds): Seconds {
  const local = Math.min(Math.max(t - clip.start, 0), clipDuration(clip));
  return clip.in + local * clip.speed;
}

/** Audio gain for a clip at timeline time `t`, including fades and track mute. */
export function clipGainAt(clip: Clip, track: Track | undefined, t: Seconds): number {
  if (!track || track.muted) return 0;
  const end = clipEnd(clip);
  let g = clip.volume;
  if (clip.fadeIn > 0) g *= Math.min(1, Math.max(0, (t - clip.start) / clip.fadeIn));
  if (clip.fadeOut > 0) g *= Math.min(1, Math.max(0, (end - t) / clip.fadeOut));
  return g;
}

/** Tracks indexed by id (cached per project instance). */
const trackCache = new WeakMap<Project, Map<string, Track>>();
export function trackMap(p: Project): Map<string, Track> {
  let m = trackCache.get(p);
  if (!m) {
    m = new Map(p.tracks.map((t) => [t.id, t]));
    trackCache.set(p, m);
  }
  return m;
}

/** Whether a clip produces a picture (video/image on a visible video track). */
export function isVisualClip(p: Project, clip: Clip): boolean {
  const asset = p.assets[clip.assetId];
  const track = trackMap(p).get(clip.trackId);
  return !!asset && !!track && track.kind === 'video' && !track.hidden && asset.hasVideo;
}

export function isAudibleClip(p: Project, clip: Clip): boolean {
  const asset = p.assets[clip.assetId];
  const track = trackMap(p).get(clip.trackId);
  return !!asset && !!track && !track.muted && asset.hasAudio && clip.volume > 0;
}

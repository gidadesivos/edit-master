import type { Seconds } from './types';

/** 00:00:00.00 style timecode (hours shown only when needed). */
export function formatTime(t: Seconds, fps = 30): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const totalFrames = Math.floor(t * fps + 1e-6);
  const frames = totalFrames % Math.round(fps);
  const totalSec = Math.floor(totalFrames / Math.round(fps));
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (h ? `${h}:${pad(m)}` : pad(m)) + `:${pad(s)}:${pad(frames)}`;
}

export function formatDuration(t: Seconds): string {
  if (!Number.isFinite(t) || t <= 0) return '0:00';
  const total = Math.round(t);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Rounds a time to the nearest frame boundary. */
export function snapToFrame(t: Seconds, fps: number): Seconds {
  return Math.round(t * fps) / fps;
}

/** Picks a "nice" ruler step (in seconds) so labels are at least `minPx` apart. */
export function rulerStep(zoom: number, minPx = 80): number {
  const steps = [1 / 30, 1 / 10, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  return steps.find((s) => s * zoom >= minPx) ?? 3600;
}

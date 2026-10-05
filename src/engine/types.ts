/** Seconds, as floating point. All timeline math is done in seconds. */
export type Seconds = number;

export type MediaKind = 'video' | 'audio' | 'image';

/** A media file the user imported. The binary itself never leaves the user's machine. */
export interface MediaAsset {
  id: string;
  kind: MediaKind;
  name: string;
  /** File size in bytes — used together with the name to re-link files after reopening a project. */
  size: number;
  /** Last-modified timestamp of the file, also used for re-linking. */
  lastModified: number;
  /** Source duration. Images use `Infinity` internally but are stored as 0 (any length allowed). */
  duration: Seconds;
  width: number;
  height: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export type TrackKind = 'video' | 'audio';

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  hidden: boolean;
}

export interface Transform {
  /** Horizontal offset as a fraction of the canvas width (0 = centered). */
  x: number;
  /** Vertical offset as a fraction of the canvas height (0 = centered). */
  y: number;
  /** 1 = fit inside the canvas. */
  scale: number;
  /** Degrees, clockwise. */
  rotation: number;
}

export interface Clip {
  id: string;
  assetId: string;
  trackId: string;
  /** Position on the timeline. */
  start: Seconds;
  /** In-point inside the source media. */
  in: Seconds;
  /** Out-point inside the source media (exclusive). */
  out: Seconds;
  /** Playback speed multiplier. 1 = normal. */
  speed: number;
  /** 0..2 (200%). */
  volume: number;
  /** 0..1 */
  opacity: number;
  transform: Transform;
  /** Fade in/out of audio, seconds. */
  fadeIn: Seconds;
  fadeOut: Seconds;
}

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  background: string;
}

export interface Project {
  /** Format version — bump when the shape changes and add a migration in serialize.ts. */
  version: 1;
  id: string;
  name: string;
  settings: ProjectSettings;
  assets: Record<string, MediaAsset>;
  /** Top-most track first. Video tracks above render above. */
  tracks: Track[];
  clips: Record<string, Clip>;
  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0 };

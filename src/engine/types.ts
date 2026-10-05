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

export type ClipKind = 'media' | 'text';

export type TextAnimation = 'none' | 'fade' | 'slide-up' | 'slide-down' | 'pop' | 'typewriter' | 'blur';

export interface TextStyle {
  content: string;
  font: string;
  /** Font size as a fraction of the canvas height (resolution independent). */
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  strokeColor: string;
  /** Outline width as a fraction of the font size. 0 = none. */
  strokeWidth: number;
  shadow: boolean;
  /** Background box colour, or '' for none. */
  background: string;
  backgroundOpacity: number;
  animIn: TextAnimation;
  animOut: TextAnimation;
  animInDuration: Seconds;
  animOutDuration: Seconds;
}

export type FilterPreset = 'none' | 'bw' | 'sepia' | 'vintage' | 'warm' | 'cool' | 'vivid' | 'fade' | 'dramatic';

/** Colour adjustments. All 0 = untouched. */
export interface Adjustments {
  /** -1..1 */
  brightness: number;
  /** -1..1 */
  contrast: number;
  /** -1..1 */
  saturation: number;
  /** -180..180 degrees */
  hue: number;
  /** -1 (cool) .. 1 (warm) */
  temperature: number;
  /** 0..1 */
  blur: number;
  /** 0..1 */
  vignette: number;
}

export type TransitionType = 'fade' | 'black' | 'slide-left' | 'slide-up' | 'wipe-left' | 'zoom' | 'circle';

/** Transition into a clip, played at its start over the end of the previous clip on the same track. */
export interface Transition {
  type: TransitionType;
  duration: Seconds;
}

export type KeyframeProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity';

export interface Keyframe {
  /** Time relative to the clip start, in timeline seconds. */
  t: Seconds;
  v: number;
}

/** Green/blue screen removal. */
export interface ChromaKey {
  color: string;
  /** 0..1 — how far from the key colour still counts as background. */
  similarity: number;
  /** 0..1 — width of the soft edge. */
  smoothness: number;
  /** 0..1 — removes the key colour's tint from the edges. */
  spill: number;
}

export interface Clip {
  id: string;
  kind: ClipKind;
  /** Media asset id ('' for text clips). */
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
  filter: FilterPreset;
  adjust: Adjustments;
  transitionIn: Transition | null;
  /** Animated properties. When a property has keyframes, they override the static value. */
  keyframes: Partial<Record<KeyframeProp, Keyframe[]>>;
  /** Present for text clips. */
  text?: TextStyle;
  chromaKey: ChromaKey | null;
  /** Remove the background with the on-device segmentation model (people). */
  removeBg: boolean;
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

export const DEFAULT_ADJUSTMENTS: Adjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  temperature: 0,
  blur: 0,
  vignette: 0,
};

export const DEFAULT_TEXT_STYLE: TextStyle = {
  content: 'Seu texto aqui',
  font: 'Segoe UI',
  size: 0.08,
  color: '#ffffff',
  bold: true,
  italic: false,
  align: 'center',
  strokeColor: '#000000',
  strokeWidth: 0.06,
  shadow: true,
  background: '',
  backgroundOpacity: 0.6,
  animIn: 'fade',
  animOut: 'fade',
  animInDuration: 0.4,
  animOutDuration: 0.4,
};

export const DEFAULT_CHROMA_KEY: ChromaKey = { color: '#00ff00', similarity: 0.4, smoothness: 0.08, spill: 0.5 };

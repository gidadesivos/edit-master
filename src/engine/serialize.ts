import { DEFAULT_SETTINGS, makeTrack } from './project';
import { KEYFRAME_PROPS } from './keyframes';
import {
  DEFAULT_ADJUSTMENTS,
  DEFAULT_TEXT_STYLE,
  DEFAULT_TRANSFORM,
  type Adjustments,
  type Clip,
  type FilterPreset,
  type Keyframe,
  type MediaAsset,
  type Project,
  type TextAnimation,
  type TextStyle,
  type Track,
  type Transition,
  type TransitionType,
} from './types';

const FILTERS: FilterPreset[] = ['none', 'bw', 'sepia', 'vintage', 'warm', 'cool', 'vivid', 'fade', 'dramatic'];
const TRANSITIONS: TransitionType[] = ['fade', 'black', 'slide-left', 'slide-up', 'wipe-left', 'zoom', 'circle'];
const TEXT_ANIMS: TextAnimation[] = ['none', 'fade', 'slide-up', 'slide-down', 'pop', 'typewriter', 'blur'];
const COLOR = /^#[0-9a-f]{6}$/i;

export const PROJECT_FILE_EXTENSION = '.emproj';
const FORMAT = 'edit-master-project';

export function serializeProject(p: Project): string {
  return JSON.stringify({ format: FORMAT, project: p }, null, 2);
}

const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);
const color = (v: unknown, fallback: string): string => (typeof v === 'string' && COLOR.test(v) ? v : fallback);

function normalizeAdjust(v: unknown): Adjustments {
  const a = isObj(v) ? v : {};
  const d = DEFAULT_ADJUSTMENTS;
  return {
    brightness: num(a.brightness, d.brightness, -1, 1),
    contrast: num(a.contrast, d.contrast, -1, 1),
    saturation: num(a.saturation, d.saturation, -1, 1),
    hue: num(a.hue, d.hue, -180, 180),
    temperature: num(a.temperature, d.temperature, -1, 1),
    blur: num(a.blur, d.blur, 0, 1),
    vignette: num(a.vignette, d.vignette, 0, 1),
  };
}

function normalizeTransition(v: unknown): Transition | null {
  if (!isObj(v) || !TRANSITIONS.includes(v.type as TransitionType)) return null;
  return { type: v.type as TransitionType, duration: num(v.duration, 0.5, 0.1, 2) };
}

function normalizeKeyframes(v: unknown): Clip['keyframes'] {
  const out: Clip['keyframes'] = {};
  if (!isObj(v)) return out;
  for (const prop of KEYFRAME_PROPS) {
    const list = v[prop];
    if (!Array.isArray(list)) continue;
    const kfs: Keyframe[] = list
      .filter((k): k is Record<string, unknown> => isObj(k) && typeof k.t === 'number' && typeof k.v === 'number')
      .map((k) => ({ t: num(k.t, 0), v: num(k.v, 0) }))
      .sort((a, b) => a.t - b.t);
    if (kfs.length) out[prop] = kfs;
  }
  return out;
}

function normalizeText(v: unknown): TextStyle {
  const t = isObj(v) ? v : {};
  const d = DEFAULT_TEXT_STYLE;
  return {
    content: str(t.content, d.content).slice(0, 5000),
    font: str(t.font, d.font).slice(0, 100),
    size: num(t.size, d.size, 0.01, 1),
    color: color(t.color, d.color),
    bold: bool(t.bold, d.bold),
    italic: bool(t.italic, d.italic),
    align: oneOf(t.align, ['left', 'center', 'right'] as const, d.align),
    strokeColor: color(t.strokeColor, d.strokeColor),
    strokeWidth: num(t.strokeWidth, d.strokeWidth, 0, 0.5),
    shadow: bool(t.shadow, d.shadow),
    background: t.background === '' ? '' : color(t.background, ''),
    backgroundOpacity: num(t.backgroundOpacity, d.backgroundOpacity, 0, 1),
    animIn: oneOf(t.animIn, TEXT_ANIMS, d.animIn),
    animOut: oneOf(t.animOut, TEXT_ANIMS, d.animOut),
    animInDuration: num(t.animInDuration, d.animInDuration, 0, 5),
    animOutDuration: num(t.animOutDuration, d.animOutDuration, 0, 5),
  };
}

export class ProjectParseError extends Error {}

/**
 * Parses and validates a project file. Unknown or broken fields are repaired with defaults
 * rather than crashing the editor; structurally invalid files throw ProjectParseError.
 */
export function parseProject(text: string): Project {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectParseError('O arquivo não é um projeto válido (JSON inválido).');
  }
  if (!isObj(raw) || raw.format !== FORMAT || !isObj(raw.project)) {
    throw new ProjectParseError('Este arquivo não é um projeto do Edit Master.');
  }
  return normalizeProject(raw.project);
}

export function normalizeProject(r: Record<string, unknown>): Project {
  const version = num(r.version, 1);
  if (version > 1) throw new ProjectParseError('Projeto criado por uma versão mais nova do Edit Master. Atualize o app.');

  const s = isObj(r.settings) ? r.settings : {};
  const settings = {
    width: Math.round(num(s.width, DEFAULT_SETTINGS.width, 16, 7680) / 2) * 2,
    height: Math.round(num(s.height, DEFAULT_SETTINGS.height, 16, 7680) / 2) * 2,
    fps: num(s.fps, DEFAULT_SETTINGS.fps, 1, 120),
    background: /^#[0-9a-f]{6}$/i.test(str(s.background, '')) ? (s.background as string) : DEFAULT_SETTINGS.background,
  };

  const assets: Record<string, MediaAsset> = {};
  for (const a of Object.values(isObj(r.assets) ? r.assets : {})) {
    if (!isObj(a) || typeof a.id !== 'string') continue;
    const kind = a.kind === 'audio' || a.kind === 'image' ? a.kind : 'video';
    assets[a.id] = {
      id: a.id,
      kind,
      name: str(a.name, 'mídia'),
      size: num(a.size, 0, 0),
      lastModified: num(a.lastModified, 0),
      duration: num(a.duration, 0, 0),
      width: num(a.width, 0, 0),
      height: num(a.height, 0, 0),
      hasAudio: bool(a.hasAudio, kind !== 'image'),
      hasVideo: bool(a.hasVideo, kind !== 'audio'),
    };
  }

  let tracks: Track[] = [];
  for (const t of Array.isArray(r.tracks) ? r.tracks : []) {
    if (!isObj(t) || typeof t.id !== 'string') continue;
    tracks.push({
      id: t.id,
      kind: t.kind === 'audio' ? 'audio' : 'video',
      name: str(t.name, 'Faixa'),
      muted: bool(t.muted, false),
      hidden: bool(t.hidden, false),
    });
  }
  if (!tracks.some((t) => t.kind === 'video')) tracks = [makeTrack('video', 'Vídeo 1'), ...tracks];
  if (!tracks.some((t) => t.kind === 'audio')) tracks = [...tracks, makeTrack('audio', 'Áudio 1')];
  const trackIds = new Set(tracks.map((t) => t.id));

  const clips: Record<string, Clip> = {};
  for (const c of Object.values(isObj(r.clips) ? r.clips : {})) {
    if (!isObj(c) || typeof c.id !== 'string') continue;
    const kind = c.kind === 'text' ? 'text' : 'media';
    const assetId = kind === 'text' ? '' : typeof c.assetId === 'string' ? c.assetId : '';
    if ((kind === 'media' && !assets[assetId]) || typeof c.trackId !== 'string' || !trackIds.has(c.trackId)) continue;
    const inPt = num(c.in, 0, 0);
    const out = num(c.out, inPt + 1, inPt + 0.001);
    const tr = isObj(c.transform) ? c.transform : {};
    const clip: Clip = {
      id: c.id,
      kind,
      assetId,
      trackId: c.trackId,
      start: num(c.start, 0, 0),
      in: inPt,
      out,
      speed: num(c.speed, 1, 0.1, 100),
      volume: num(c.volume, 1, 0, 2),
      opacity: num(c.opacity, 1, 0, 1),
      transform: {
        x: num(tr.x, DEFAULT_TRANSFORM.x, -10, 10),
        y: num(tr.y, DEFAULT_TRANSFORM.y, -10, 10),
        scale: num(tr.scale, DEFAULT_TRANSFORM.scale, 0.01, 20),
        rotation: num(tr.rotation, DEFAULT_TRANSFORM.rotation, -3600, 3600),
      },
      fadeIn: num(c.fadeIn, 0, 0),
      fadeOut: num(c.fadeOut, 0, 0),
      filter: oneOf(c.filter, FILTERS, 'none'),
      adjust: normalizeAdjust(c.adjust),
      transitionIn: normalizeTransition(c.transitionIn),
      keyframes: normalizeKeyframes(c.keyframes),
    };
    if (kind === 'text') clip.text = normalizeText(c.text);
    clips[c.id] = clip;
  }

  return {
    version: 1,
    id: str(r.id, crypto.randomUUID()),
    name: str(r.name, 'Projeto sem título'),
    settings,
    assets,
    tracks,
    clips,
    createdAt: num(r.createdAt, Date.now()),
    updatedAt: num(r.updatedAt, Date.now()),
  };
}

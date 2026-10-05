import { DEFAULT_SETTINGS, makeTrack } from './project';
import { DEFAULT_TRANSFORM, type Clip, type MediaAsset, type Project, type Track } from './types';

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
    if (!isObj(c) || typeof c.id !== 'string' || typeof c.assetId !== 'string') continue;
    if (!assets[c.assetId] || typeof c.trackId !== 'string' || !trackIds.has(c.trackId)) continue;
    const inPt = num(c.in, 0, 0);
    const out = num(c.out, inPt + 1, inPt + 0.001);
    const tr = isObj(c.transform) ? c.transform : {};
    clips[c.id] = {
      id: c.id,
      assetId: c.assetId,
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
    };
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

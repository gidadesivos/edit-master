/**
 * Pure, immutable editing operations on a Project.
 * Every function returns a new Project (or the same instance when nothing changed),
 * which keeps undo/redo trivial and makes the logic easy to unit test.
 */
import { scaleKeyframes, shiftKeyframes, splitKeyframes } from './keyframes';
import {
  DEFAULT_ADJUSTMENTS,
  DEFAULT_TEXT_STYLE,
  DEFAULT_TRANSFORM,
  type Clip,
  type TextStyle,
  type Transition,
  type MediaAsset,
  type Project,
  type ProjectSettings,
  type Seconds,
  type Track,
  type TrackKind,
} from './types';

export const EPS = 1e-6;
/** Shortest clip allowed on the timeline (about 1 frame at 30fps). */
export const MIN_CLIP_DURATION = 1 / 30;
export const DEFAULT_IMAGE_DURATION = 5;

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  background: '#000000',
};

export function createProject(name = 'Projeto sem título', settings: Partial<ProjectSettings> = {}): Project {
  const now = Date.now();
  return {
    version: 1,
    id: uid(),
    name,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    assets: {},
    tracks: [makeTrack('video', 'Vídeo 1'), makeTrack('audio', 'Áudio 1')],
    clips: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function makeTrack(kind: TrackKind, name: string): Track {
  return { id: uid(), kind, name, muted: false, hidden: false };
}

// ---------- queries ----------

export const clipDuration = (c: Clip): Seconds => (c.out - c.in) / c.speed;
export const clipEnd = (c: Clip): Seconds => c.start + clipDuration(c);

export function projectDuration(p: Project): Seconds {
  let end = 0;
  for (const c of Object.values(p.clips)) end = Math.max(end, clipEnd(c));
  return end;
}

export function trackKindForAsset(asset: MediaAsset): TrackKind {
  return asset.kind === 'audio' ? 'audio' : 'video';
}

export function clipsOnTrack(p: Project, trackId: string, ignore: ReadonlySet<string> = new Set()): Clip[] {
  return Object.values(p.clips)
    .filter((c) => c.trackId === trackId && !ignore.has(c.id))
    .sort((a, b) => a.start - b.start);
}

export function trackEnd(p: Project, trackId: string): Seconds {
  return clipsOnTrack(p, trackId).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

/** Clips visible/audible at time `t`, ordered bottom track first (render order). */
export function clipsAtTime(p: Project, t: Seconds): Clip[] {
  const order = new Map(p.tracks.map((tr, i) => [tr.id, i]));
  return Object.values(p.clips)
    .filter((c) => c.start <= t + EPS && t < clipEnd(c) - EPS)
    .sort((a, b) => (order.get(b.trackId) ?? 0) - (order.get(a.trackId) ?? 0));
}

export function canPlace(
  p: Project,
  trackId: string,
  start: Seconds,
  duration: Seconds,
  ignore: ReadonlySet<string> = new Set(),
): boolean {
  if (start < -EPS) return false;
  const end = start + duration;
  return clipsOnTrack(p, trackId, ignore).every((c) => end <= c.start + EPS || start >= clipEnd(c) - EPS);
}

/** Closest start time to `desired` where a clip of `duration` fits on the track without overlapping. */
export function nearestFreeStart(
  p: Project,
  trackId: string,
  desired: Seconds,
  duration: Seconds,
  ignore: ReadonlySet<string> = new Set(),
): Seconds {
  desired = Math.max(0, desired);
  if (canPlace(p, trackId, desired, duration, ignore)) return desired;
  const clips = clipsOnTrack(p, trackId, ignore);
  // Gaps: [0, first.start], [a.end, b.start], ..., [last.end, Infinity]
  const gaps: Array<[number, number]> = [];
  let cursor = 0;
  for (const c of clips) {
    if (c.start - cursor >= duration - EPS) gaps.push([cursor, c.start]);
    cursor = Math.max(cursor, clipEnd(c));
  }
  gaps.push([cursor, Infinity]);
  let best = cursor;
  let bestDist = Infinity;
  for (const [g0, g1] of gaps) {
    const latest = g1 - duration;
    const candidate = Math.min(Math.max(desired, g0), latest);
    const dist = Math.abs(candidate - desired);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

// ---------- helpers ----------

function touch(p: Project, patch: Partial<Project>): Project {
  return { ...p, ...patch, updatedAt: Date.now() };
}

function withClip(p: Project, clip: Clip): Project {
  return touch(p, { clips: { ...p.clips, [clip.id]: clip } });
}

/** Text and image clips can be stretched to any length; audio/video are limited by the source. */
export function isUnbounded(p: Project, clip: Clip): boolean {
  return clip.kind === 'text' || p.assets[clip.assetId]?.kind === 'image';
}

function sourceLimit(p: Project, clip: Clip): Seconds {
  const asset = p.assets[clip.assetId];
  if (!asset || isUnbounded(p, clip)) return Infinity;
  return asset.duration;
}

/** A fresh clip with every field at its default. */
export function makeClip(fields: Pick<Clip, 'assetId' | 'trackId' | 'start' | 'in' | 'out'> & Partial<Clip>): Clip {
  return {
    id: uid(),
    kind: 'media',
    speed: 1,
    volume: 1,
    opacity: 1,
    transform: { ...DEFAULT_TRANSFORM },
    fadeIn: 0,
    fadeOut: 0,
    filter: 'none',
    adjust: { ...DEFAULT_ADJUSTMENTS },
    transitionIn: null,
    keyframes: {},
    chromaKey: null,
    removeBg: false,
    ...fields,
  };
}

// ---------- assets ----------

export function addAsset(p: Project, asset: MediaAsset): Project {
  return touch(p, { assets: { ...p.assets, [asset.id]: asset } });
}

export function removeAsset(p: Project, assetId: string): Project {
  const assets = { ...p.assets };
  delete assets[assetId];
  const clips = Object.fromEntries(Object.entries(p.clips).filter(([, c]) => c.assetId !== assetId));
  return touch(p, { assets, clips });
}

// ---------- tracks ----------

export function addTrack(p: Project, kind: TrackKind): { project: Project; trackId: string } {
  const count = p.tracks.filter((t) => t.kind === kind).length + 1;
  const track = makeTrack(kind, `${kind === 'video' ? 'Vídeo' : 'Áudio'} ${count}`);
  // New video tracks go above the existing ones; new audio tracks go to the bottom.
  const tracks = kind === 'video' ? [track, ...p.tracks] : [...p.tracks, track];
  return { project: touch(p, { tracks }), trackId: track.id };
}

export function removeTrack(p: Project, trackId: string): Project {
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track) return p;
  // Always keep at least one track of each kind.
  if (p.tracks.filter((t) => t.kind === track.kind).length <= 1) {
    const clips = Object.fromEntries(Object.entries(p.clips).filter(([, c]) => c.trackId !== trackId));
    return touch(p, { clips });
  }
  const clips = Object.fromEntries(Object.entries(p.clips).filter(([, c]) => c.trackId !== trackId));
  return touch(p, { tracks: p.tracks.filter((t) => t.id !== trackId), clips });
}

export function updateTrack(p: Project, trackId: string, patch: Partial<Omit<Track, 'id' | 'kind'>>): Project {
  return touch(p, { tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)) });
}

// ---------- clips ----------

export interface AddClipOptions {
  trackId?: string;
  start?: Seconds;
}

export function addClip(p: Project, assetId: string, opts: AddClipOptions = {}): { project: Project; clipId: string } {
  const asset = p.assets[assetId];
  if (!asset) throw new Error(`Mídia não encontrada: ${assetId}`);
  const kind = trackKindForAsset(asset);
  const duration = asset.kind === 'image' ? DEFAULT_IMAGE_DURATION : asset.duration;

  let project = p;
  let track = p.tracks.find((t) => t.id === opts.trackId && t.kind === kind) ?? p.tracks.find((t) => t.kind === kind);
  if (!track) {
    const r = addTrack(project, kind);
    project = r.project;
    track = project.tracks.find((t) => t.id === r.trackId)!;
  }

  let start = opts.start ?? trackEnd(project, track.id);
  start = Math.max(0, start);
  if (!canPlace(project, track.id, start, duration)) {
    if (opts.start === undefined) {
      start = nearestFreeStart(project, track.id, start, duration);
    } else {
      // Dropped on an occupied spot: use another free track of the same kind or create one.
      const free = project.tracks.find((t) => t.kind === kind && canPlace(project, t.id, start, duration));
      if (free) track = free;
      else {
        const r = addTrack(project, kind);
        project = r.project;
        track = project.tracks.find((t) => t.id === r.trackId)!;
      }
    }
  }

  const clip = makeClip({ assetId, trackId: track.id, start, in: 0, out: duration });
  return { project: withClip(project, clip), clipId: clip.id };
}

export const DEFAULT_TEXT_DURATION = 3;

/** Adds a text clip on the top-most video track that has room (creating one if needed). */
export function addTextClip(
  p: Project,
  start: Seconds,
  style: Partial<TextStyle> = {},
  duration = DEFAULT_TEXT_DURATION,
): { project: Project; clipId: string } {
  let project = p;
  start = Math.max(0, start);
  let track = project.tracks.find((t) => t.kind === 'video' && canPlace(project, t.id, start, duration));
  if (!track) {
    const r = addTrack(project, 'video');
    project = r.project;
    track = project.tracks.find((t) => t.id === r.trackId)!;
  }
  const clip = makeClip({
    kind: 'text',
    assetId: '',
    trackId: track.id,
    start,
    in: 0,
    out: duration,
    text: { ...DEFAULT_TEXT_STYLE, ...style },
  });
  return { project: withClip(project, clip), clipId: clip.id };
}

export function updateText(p: Project, clipId: string, patch: Partial<TextStyle>): Project {
  const clip = p.clips[clipId];
  if (!clip?.text) return p;
  return withClip(p, { ...clip, text: { ...clip.text, ...patch } });
}

export function updateClip(p: Project, clipId: string, patch: Partial<Omit<Clip, 'id'>>): Project {
  const clip = p.clips[clipId];
  if (!clip) return p;
  return withClip(p, { ...clip, ...patch });
}

/**
 * Moves clips by a common time delta, and optionally the primary clip to another track.
 * Positions are resolved so that clips never overlap.
 */
export function moveClip(p: Project, clipId: string, trackId: string, start: Seconds): Project {
  const clip = p.clips[clipId];
  const track = p.tracks.find((t) => t.id === trackId);
  const current = p.tracks.find((t) => t.id === clip?.trackId);
  if (!clip || !track || !current || track.kind !== current.kind) return p;
  const ignore = new Set([clipId]);
  const resolved = nearestFreeStart(p, trackId, start, clipDuration(clip), ignore);
  if (Math.abs(resolved - clip.start) < EPS && trackId === clip.trackId) return p;
  return withClip(p, { ...clip, trackId, start: resolved });
}

export function trimClip(p: Project, clipId: string, edge: 'start' | 'end', time: Seconds): Project {
  const clip = p.clips[clipId];
  if (!clip) return p;
  const isImage = isUnbounded(p, clip);
  const limit = sourceLimit(p, clip);
  const others = clipsOnTrack(p, clip.trackId, new Set([clipId]));
  const end = clipEnd(clip);

  if (edge === 'end') {
    const next = others.find((c) => c.start >= clip.start + EPS);
    let max = next ? next.start : Infinity;
    max = Math.min(max, clip.start + (limit - clip.in) / clip.speed);
    const newEnd = Math.min(Math.max(time, clip.start + MIN_CLIP_DURATION), max);
    return withClip(p, { ...clip, out: clip.in + (newEnd - clip.start) * clip.speed });
  }

  const prev = [...others].reverse().find((c) => clipEnd(c) <= clip.start + EPS);
  let min = prev ? clipEnd(prev) : 0;
  if (!isImage) min = Math.max(min, clip.start - clip.in / clip.speed);
  const newStart = Math.max(Math.min(time, end - MIN_CLIP_DURATION), min);
  const keyframes = shiftKeyframes(clip, newStart - clip.start);
  if (isImage) {
    return withClip(p, { ...clip, start: newStart, in: 0, out: (end - newStart) * clip.speed, keyframes });
  }
  return withClip(p, { ...clip, start: newStart, in: clip.in + (newStart - clip.start) * clip.speed, keyframes });
}

export function splitClip(p: Project, clipId: string, time: Seconds): { project: Project; newClipId: string | null } {
  const clip = p.clips[clipId];
  if (!clip) return { project: p, newClipId: null };
  const end = clipEnd(clip);
  if (time <= clip.start + MIN_CLIP_DURATION - EPS || time >= end - MIN_CLIP_DURATION + EPS) {
    return { project: p, newClipId: null };
  }
  const cut = clip.in + (time - clip.start) * clip.speed;
  const [leftKf, rightKf] = splitKeyframes(clip, time - clip.start);
  const unbounded = isUnbounded(p, clip);
  const left: Clip = { ...clip, out: cut, fadeOut: 0, keyframes: leftKf };
  const right: Clip = {
    ...clip,
    id: uid(),
    start: time,
    // Text/images restart their "source" at 0 so text animations play relative to each piece.
    in: unbounded ? 0 : cut,
    out: unbounded ? clip.out - cut : clip.out,
    fadeIn: 0,
    transitionIn: null,
    transform: { ...clip.transform },
    keyframes: rightKf,
  };
  if (unbounded) left.in = 0;
  return {
    project: touch(p, { clips: { ...p.clips, [left.id]: left, [right.id]: right } }),
    newClipId: right.id,
  };
}

/** Splits the given clips (or every clip under the playhead when none given) at `time`. */
export function splitAt(p: Project, time: Seconds, clipIds?: string[]): { project: Project; newClipIds: string[] } {
  const ids = clipIds?.length ? clipIds : clipsAtTime(p, time).map((c) => c.id);
  let project = p;
  const newClipIds: string[] = [];
  for (const id of ids) {
    const r = splitClip(project, id, time);
    project = r.project;
    if (r.newClipId) newClipIds.push(r.newClipId);
  }
  return { project, newClipIds };
}

export function deleteClips(p: Project, ids: string[]): Project {
  if (!ids.some((id) => p.clips[id])) return p;
  const clips = { ...p.clips };
  for (const id of ids) delete clips[id];
  return touch(p, { clips });
}

/** Deletes clips and closes the gaps they leave on their tracks. */
export function rippleDelete(p: Project, ids: string[]): Project {
  const removed = ids.map((id) => p.clips[id]).filter(Boolean).sort((a, b) => b.start - a.start);
  if (!removed.length) return p;
  let clips = { ...p.clips };
  for (const r of removed) {
    delete clips[r.id];
    const d = clipDuration(r);
    clips = Object.fromEntries(
      Object.entries(clips).map(([id, c]) =>
        c.trackId === r.trackId && c.start >= r.start - EPS ? [id, { ...c, start: Math.max(0, c.start - d) }] : [id, c],
      ),
    );
  }
  return touch(p, { clips });
}

export function duplicateClip(p: Project, clipId: string): { project: Project; clipId: string | null } {
  const clip = p.clips[clipId];
  if (!clip) return { project: p, clipId: null };
  const start = nearestFreeStart(p, clip.trackId, clipEnd(clip), clipDuration(clip));
  const copy: Clip = { ...clip, id: uid(), start, transform: { ...clip.transform } };
  return { project: withClip(p, copy), clipId: copy.id };
}

// ---------- snapping ----------

/** Candidate times that dragged edges snap to. */
export function snapPoints(p: Project, ignore: ReadonlySet<string>, extra: Seconds[] = []): Seconds[] {
  const pts = [0, ...extra];
  for (const c of Object.values(p.clips)) {
    if (ignore.has(c.id)) continue;
    pts.push(c.start, clipEnd(c));
  }
  return pts;
}

/** Returns the snapped value of `t`, or `t` when no point is within `threshold`. */
export function snap(t: Seconds, points: Seconds[], threshold: Seconds): Seconds {
  let best = t;
  let bestDist = threshold;
  for (const pt of points) {
    const d = Math.abs(pt - t);
    if (d <= bestDist) {
      bestDist = d;
      best = pt;
    }
  }
  return best;
}

/** Snaps a moving range [start, start+duration] by either edge. Returns the adjusted start. */
export function snapRange(start: Seconds, duration: Seconds, points: Seconds[], threshold: Seconds): Seconds {
  const s = snap(start, points, threshold);
  const e = snap(start + duration, points, threshold);
  const ds = Math.abs(s - start);
  const de = Math.abs(e - (start + duration));
  if (s !== start && (e === start + duration || ds <= de)) return s;
  if (e !== start + duration) return e - duration;
  return start;
}

// ---------- speed, audio, transitions ----------

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

/**
 * Changes playback speed. The clip keeps its source range, so its length changes; clips after it on the
 * same track are shifted (ripple) so nothing overlaps and no gaps appear.
 */
export function setClipSpeed(p: Project, clipId: string, speed: number): Project {
  const clip = p.clips[clipId];
  if (!clip || clip.kind === 'text') return p;
  speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  if (Math.abs(speed - clip.speed) < 1e-6) return p;
  const oldEnd = clipEnd(clip);
  const factor = clip.speed / speed;
  const updated: Clip = {
    ...clip,
    speed,
    keyframes: scaleKeyframes(clip, factor),
    fadeIn: clip.fadeIn * factor,
    fadeOut: clip.fadeOut * factor,
  };
  const delta = clipEnd(updated) - oldEnd;
  const clips = { ...p.clips, [clipId]: updated };
  for (const c of Object.values(p.clips)) {
    if (c.id !== clipId && c.trackId === clip.trackId && c.start >= oldEnd - EPS) {
      clips[c.id] = { ...c, start: Math.max(0, c.start + delta) };
    }
  }
  return touch(p, { clips });
}

/** Copies the audio of a video clip to an audio track and mutes the original. */
export function extractAudio(p: Project, clipId: string): { project: Project; clipId: string | null } {
  const clip = p.clips[clipId];
  const asset = clip && p.assets[clip.assetId];
  if (!clip || !asset || asset.kind !== 'video' || !asset.hasAudio) return { project: p, clipId: null };
  const dur = clipDuration(clip);
  let project = p;
  let track = project.tracks.find((t) => t.kind === 'audio' && canPlace(project, t.id, clip.start, dur));
  if (!track) {
    const r = addTrack(project, 'audio');
    project = r.project;
    track = project.tracks.find((t) => t.id === r.trackId)!;
  }
  const audio = makeClip({
    assetId: clip.assetId,
    trackId: track.id,
    start: clip.start,
    in: clip.in,
    out: clip.out,
    speed: clip.speed,
    volume: clip.volume || 1,
    fadeIn: clip.fadeIn,
    fadeOut: clip.fadeOut,
  });
  project = withClip(project, audio);
  project = withClip(project, { ...project.clips[clipId], volume: 0, fadeIn: 0, fadeOut: 0 });
  return { project, clipId: audio.id };
}

/** The clip that ends exactly where `clip` starts on the same track (within one frame). */
export function previousAdjacent(p: Project, clip: Clip, tolerance = 1 / 60): Clip | null {
  for (const c of Object.values(p.clips)) {
    if (c.id !== clip.id && c.trackId === clip.trackId && Math.abs(clipEnd(c) - clip.start) <= tolerance) return c;
  }
  return null;
}

export const MAX_TRANSITION = 2;

export function maxTransitionDuration(clip: Clip): Seconds {
  return Math.max(0.1, Math.min(MAX_TRANSITION, clipDuration(clip) / 2));
}

export function setTransition(p: Project, clipId: string, transition: Transition | null): Project {
  const clip = p.clips[clipId];
  if (!clip) return p;
  const t = transition && { ...transition, duration: Math.min(maxTransitionDuration(clip), Math.max(0.1, transition.duration)) };
  return withClip(p, { ...clip, transitionIn: t });
}

/**
 * Extra time each clip stays visible after its end, because the next clip transitions over it.
 * Keys are clip ids of the *outgoing* clips.
 */
export function transitionTails(p: Project): Map<string, Seconds> {
  const tails = new Map<string, Seconds>();
  for (const c of Object.values(p.clips)) {
    if (!c.transitionIn) continue;
    const prev = previousAdjacent(p, c);
    if (prev) tails.set(prev.id, Math.max(tails.get(prev.id) ?? 0, c.transitionIn.duration));
  }
  return tails;
}

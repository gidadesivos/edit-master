/** Keyframe animation of clip properties (position, scale, rotation, opacity). */
import type { Clip, Keyframe, KeyframeProp, Seconds } from './types';

export const KEYFRAME_PROPS: KeyframeProp[] = ['x', 'y', 'scale', 'rotation', 'opacity'];
/** Two keyframes closer than this are considered the same. */
export const KEYFRAME_EPS = 1 / 120;

const smooth = (u: number) => u * u * (3 - 2 * u);

export function staticValue(clip: Clip, prop: KeyframeProp): number {
  return prop === 'opacity' ? clip.opacity : clip.transform[prop];
}

/** Value of a property at time `local` (seconds since clip start), with smooth easing between keyframes. */
export function valueAt(clip: Clip, prop: KeyframeProp, local: Seconds): number {
  const kfs = clip.keyframes[prop];
  if (!kfs?.length) return staticValue(clip, prop);
  if (local <= kfs[0].t) return kfs[0].v;
  const last = kfs[kfs.length - 1];
  if (local >= last.t) return last.v;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (local >= a.t && local <= b.t) {
      const u = b.t - a.t < 1e-9 ? 1 : (local - a.t) / (b.t - a.t);
      return a.v + (b.v - a.v) * smooth(u);
    }
  }
  return last.v;
}

export function hasKeyframes(clip: Clip, prop?: KeyframeProp): boolean {
  if (prop) return !!clip.keyframes[prop]?.length;
  return KEYFRAME_PROPS.some((p) => clip.keyframes[p]?.length);
}

export function keyframeAt(clip: Clip, prop: KeyframeProp, local: Seconds): Keyframe | undefined {
  return clip.keyframes[prop]?.find((k) => Math.abs(k.t - local) < KEYFRAME_EPS);
}

/** Inserts or replaces the keyframe at `local`. */
export function upsertKeyframe(clip: Clip, prop: KeyframeProp, local: Seconds, v: number): Clip {
  const list = (clip.keyframes[prop] ?? []).filter((k) => Math.abs(k.t - local) >= KEYFRAME_EPS);
  list.push({ t: local, v });
  list.sort((a, b) => a.t - b.t);
  return { ...clip, keyframes: { ...clip.keyframes, [prop]: list } };
}

export function removeKeyframe(clip: Clip, prop: KeyframeProp, local: Seconds): Clip {
  const list = (clip.keyframes[prop] ?? []).filter((k) => Math.abs(k.t - local) >= KEYFRAME_EPS);
  const keyframes = { ...clip.keyframes };
  if (list.length) keyframes[prop] = list;
  else delete keyframes[prop];
  return { ...clip, keyframes };
}

/** Removes all keyframes of a property, keeping its current animated value as the static value. */
export function clearKeyframes(clip: Clip, prop: KeyframeProp, local: Seconds): Clip {
  const v = valueAt(clip, prop, local);
  const keyframes = { ...clip.keyframes };
  delete keyframes[prop];
  const base = { ...clip, keyframes };
  return prop === 'opacity' ? { ...base, opacity: v } : { ...base, transform: { ...clip.transform, [prop]: v } };
}

/** Sets a property: updates the keyframe at `local` when the property is animated, otherwise the static value. */
export function setProp(clip: Clip, prop: KeyframeProp, local: Seconds, v: number): Clip {
  if (hasKeyframes(clip, prop)) return upsertKeyframe(clip, prop, local, v);
  return prop === 'opacity' ? { ...clip, opacity: v } : { ...clip, transform: { ...clip.transform, [prop]: v } };
}

function mapKeyframes(clip: Clip, fn: (list: Keyframe[], prop: KeyframeProp) => Keyframe[]): Clip['keyframes'] {
  const out: Clip['keyframes'] = {};
  for (const prop of KEYFRAME_PROPS) {
    const list = clip.keyframes[prop];
    if (!list?.length) continue;
    const mapped = fn(list, prop);
    if (mapped.length) out[prop] = mapped;
  }
  return out;
}

/** Shifts keyframes so they stay attached to the same content when the clip start moves by `delta`. */
export function shiftKeyframes(clip: Clip, delta: Seconds): Clip['keyframes'] {
  return mapKeyframes(clip, (list) => list.map((k) => ({ ...k, t: k.t - delta })));
}

/** Scales keyframe times (used when the clip speed changes). */
export function scaleKeyframes(clip: Clip, factor: number): Clip['keyframes'] {
  return mapKeyframes(clip, (list) => list.map((k) => ({ ...k, t: k.t * factor })));
}

/**
 * Keyframes for the two halves of a clip split at local time `cut`. Both halves keep every keyframe
 * (the right half shifted), so the animation curve stays exactly the same; keys outside a half's
 * range are simply not reached unless the clip is extended again.
 */
export function splitKeyframes(clip: Clip, cut: Seconds): [Clip['keyframes'], Clip['keyframes']] {
  return [mapKeyframes(clip, (list) => list.map((k) => ({ ...k }))), shiftKeyframes(clip, cut)];
}

/** Distinct keyframe times inside the clip (for timeline markers and navigation). */
export function keyframeTimes(clip: Clip): Seconds[] {
  const times: Seconds[] = [];
  const dur = (clip.out - clip.in) / clip.speed;
  for (const prop of KEYFRAME_PROPS) {
    for (const k of clip.keyframes[prop] ?? []) {
      if (k.t < -KEYFRAME_EPS || k.t > dur + KEYFRAME_EPS) continue;
      if (!times.some((t) => Math.abs(t - k.t) < KEYFRAME_EPS)) times.push(k.t);
    }
  }
  return times.sort((a, b) => a - b);
}

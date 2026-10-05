import { describe, expect, it } from 'vitest';
import { clearKeyframes, keyframeTimes, removeKeyframe, setProp, splitKeyframes, upsertKeyframe, valueAt } from './keyframes';
import {
  addAsset,
  addClip,
  addTextClip,
  clipDuration,
  clipEnd,
  createProject,
  extractAudio,
  previousAdjacent,
  setClipSpeed,
  setTransition,
  splitClip,
  transitionTails,
  trimClip,
  updateText,
} from './project';
import { parseProject, serializeProject } from './serialize';
import type { MediaAsset, Project } from './types';
import { frameItems, filterCss, toneOf, clipGainAt } from '../render/compositor';

const video: MediaAsset = {
  id: 'v',
  kind: 'video',
  name: 'v.mp4',
  size: 1,
  lastModified: 0,
  duration: 10,
  width: 1920,
  height: 1080,
  hasAudio: true,
  hasVideo: true,
};

function withTwoClips(): { p: Project; a: string; b: string } {
  let p = addAsset(createProject(), video);
  const ra = addClip(p, 'v');
  p = ra.project;
  p = trimClip(p, ra.clipId, 'end', 4); // [0,4]
  const rb = addClip(p, 'v'); // [4,14]
  return { p: rb.project, a: ra.clipId, b: rb.clipId };
}

describe('keyframes', () => {
  it('interpolates smoothly and holds outside the range', () => {
    let { p, a } = withTwoClips();
    let c = p.clips[a];
    c = upsertKeyframe(c, 'x', 1, 0);
    c = upsertKeyframe(c, 'x', 3, 1);
    expect(valueAt(c, 'x', 0)).toBe(0);
    expect(valueAt(c, 'x', 2)).toBeCloseTo(0.5);
    expect(valueAt(c, 'x', 1.5)).toBeLessThan(0.25); // eased
    expect(valueAt(c, 'x', 5)).toBe(1);
    expect(valueAt(c, 'scale', 2)).toBe(1); // untouched prop uses the static value
    p = { ...p, clips: { ...p.clips, [a]: c } };
    expect(keyframeTimes(p.clips[a])).toEqual([1, 3]);
  });

  it('setProp updates the keyframe when animated, the static value otherwise', () => {
    const { p, a } = withTwoClips();
    let c = setProp(p.clips[a], 'opacity', 1, 0.5);
    expect(c.opacity).toBe(0.5);
    c = upsertKeyframe(c, 'opacity', 0, 1);
    c = setProp(c, 'opacity', 2, 0.2);
    expect(c.keyframes.opacity).toHaveLength(2);
    expect(c.opacity).toBe(0.5);
    c = removeKeyframe(c, 'opacity', 0);
    c = clearKeyframes(c, 'opacity', 2);
    expect(c.keyframes.opacity).toBeUndefined();
    expect(c.opacity).toBeCloseTo(0.2);
  });

  it('split keeps the animation continuous on both halves', () => {
    const { p, a } = withTwoClips();
    let c = upsertKeyframe(p.clips[a], 'scale', 0, 1);
    c = upsertKeyframe(c, 'scale', 4, 2);
    const [left, right] = splitKeyframes(c, 2);
    expect(left.scale).toEqual(c.keyframes.scale);
    expect(right.scale!.map((k) => k.t)).toEqual([-2, 2]);

    const q = { ...p, clips: { ...p.clips, [a]: c } };
    const r = splitClip(q, a, 2);
    for (const t of [0, 0.5, 1, 1.7]) expect(valueAt(r.project.clips[r.newClipId!], 'scale', t)).toBeCloseTo(valueAt(c, 'scale', 2 + t));
    for (const t of [0, 1, 1.9]) expect(valueAt(r.project.clips[a], 'scale', t)).toBeCloseTo(valueAt(c, 'scale', t));
  });

  it('trimming the start keeps keyframes attached to the content', () => {
    const { p, a } = withTwoClips();
    const c = upsertKeyframe(p.clips[a], 'x', 3, 0.5);
    const q = trimClip({ ...p, clips: { ...p.clips, [a]: c } }, a, 'start', 1);
    expect(q.clips[a].keyframes.x![0].t).toBeCloseTo(2);
  });
});

describe('text clips', () => {
  it('are placed on a free video track and can be stretched freely', () => {
    const { p } = withTwoClips();
    const r = addTextClip(p, 1);
    const t = r.project.clips[r.clipId];
    expect(t.kind).toBe('text');
    expect(t.trackId).not.toBe(p.clips[Object.keys(p.clips)[0]].trackId); // video track is occupied at 1s
    const stretched = trimClip(r.project, r.clipId, 'end', 60);
    expect(clipEnd(stretched.clips[r.clipId])).toBeCloseTo(60);
    const edited = updateText(stretched, r.clipId, { content: 'Olá' });
    expect(edited.clips[r.clipId].text!.content).toBe('Olá');
  });

  it('splitting a text clip restarts its animation timing on the right half', () => {
    const r = addTextClip(createProject(), 0);
    const s = splitClip(r.project, r.clipId, 1);
    const right = s.project.clips[s.newClipId!];
    expect(right.in).toBe(0);
    expect(clipDuration(right)).toBeCloseTo(2);
    expect(clipDuration(s.project.clips[r.clipId])).toBeCloseTo(1);
  });

  it('round-trips through the project file', () => {
    const r = addTextClip(createProject(), 0, { content: 'Linha 1\nLinha 2', color: '#ff0000' });
    const back = parseProject(serializeProject(r.project));
    expect(back.clips[r.clipId]).toEqual(r.project.clips[r.clipId]);
  });
});

describe('speed', () => {
  it('changes duration and ripples the following clips', () => {
    const { p, a, b } = withTwoClips();
    const q = setClipSpeed(p, a, 2);
    expect(clipDuration(q.clips[a])).toBeCloseTo(2);
    expect(q.clips[b].start).toBeCloseTo(2);
    const slow = setClipSpeed(p, a, 0.5);
    expect(clipDuration(slow.clips[a])).toBeCloseTo(8);
    expect(slow.clips[b].start).toBeCloseTo(8);
  });

  it('clamps to the supported range and ignores text', () => {
    const { p, a } = withTwoClips();
    expect(setClipSpeed(p, a, 100).clips[a].speed).toBe(4);
    const r = addTextClip(p, 20);
    expect(setClipSpeed(r.project, r.clipId, 2)).toBe(r.project);
  });
});

describe('extract audio', () => {
  it('creates an audio clip and mutes the video', () => {
    const { p, a } = withTwoClips();
    const r = extractAudio(p, a);
    const audio = r.project.clips[r.clipId!];
    expect(r.project.tracks.find((t) => t.id === audio.trackId)!.kind).toBe('audio');
    expect(audio.start).toBe(p.clips[a].start);
    expect(audio.out).toBe(p.clips[a].out);
    expect(r.project.clips[a].volume).toBe(0);
  });
});

describe('transitions', () => {
  it('finds the adjacent clip and computes its tail', () => {
    const { p, a, b } = withTwoClips();
    expect(previousAdjacent(p, p.clips[b])?.id).toBe(a);
    const q = setTransition(p, b, { type: 'fade', duration: 1 });
    expect(transitionTails(q).get(a)).toBe(1);
    expect(setTransition(q, b, { type: 'fade', duration: 99 }).clips[b].transitionIn!.duration).toBeLessThanOrEqual(2);
  });

  it('draws the outgoing clip under the incoming one during the transition', () => {
    const { p, a, b } = withTwoClips();
    const q = setTransition(p, b, { type: 'slide-left', duration: 1 });
    const during = frameItems(q, 4.5);
    expect(during.map((i) => i.clip.id)).toEqual([a, b]);
    expect(during[0].transition).toMatchObject({ role: 'out', p: 0.5 });
    expect(during[0].srcTime).toBeCloseTo(4.5); // keeps playing past its out-point
    expect(frameItems(q, 5.5).map((i) => i.clip.id)).toEqual([b]);
  });
});

describe('filters and audio gain', () => {
  it('builds css filters and tone', () => {
    const { p, a } = withTwoClips();
    const c = { ...p.clips[a], filter: 'bw' as const, adjust: { ...p.clips[a].adjust, brightness: 0.2, blur: 0.5, temperature: 0.3 } };
    const css = filterCss(c, 1000);
    expect(css).toContain('grayscale(1)');
    expect(css).toContain('brightness(1.200)');
    expect(css).toContain('blur(10.00px)');
    expect(toneOf(c).temperature).toBeCloseTo(0.3);
    expect(filterCss(p.clips[a], 1000)).toBe('none');
  });

  it('gain is zero outside the clip (transition tails stay silent)', () => {
    const { p, a } = withTwoClips();
    const track = p.tracks.find((t) => t.id === p.clips[a].trackId);
    expect(clipGainAt(p.clips[a], track, 2)).toBe(1);
    expect(clipGainAt(p.clips[a], track, 4.2)).toBe(0);
  });
});

describe('compatibility', () => {
  it('opens v0.1 projects (clips without the new fields)', () => {
    const { p, a } = withTwoClips();
    const raw = JSON.parse(serializeProject(p));
    for (const c of Object.values(raw.project.clips) as Array<Record<string, unknown>>) {
      delete c.kind;
      delete c.filter;
      delete c.adjust;
      delete c.transitionIn;
      delete c.keyframes;
    }
    const back = parseProject(JSON.stringify(raw));
    expect(back.clips[a].kind).toBe('media');
    expect(back.clips[a].filter).toBe('none');
    expect(back.clips[a].keyframes).toEqual({});
    expect(back.clips[a].transitionIn).toBeNull();
  });
});

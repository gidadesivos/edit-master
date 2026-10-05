import { describe, expect, it } from 'vitest';
import {
  addAsset,
  addClip,
  canPlace,
  clipDuration,
  clipEnd,
  clipsAtTime,
  createProject,
  deleteClips,
  duplicateClip,
  moveClip,
  nearestFreeStart,
  projectDuration,
  removeAsset,
  removeTrack,
  rippleDelete,
  snap,
  snapRange,
  splitAt,
  splitClip,
  trimClip,
} from './project';
import type { MediaAsset, Project } from './types';

function asset(id: string, kind: MediaAsset['kind'], duration: number): MediaAsset {
  return {
    id,
    kind,
    name: `${id}.bin`,
    size: 100,
    lastModified: 0,
    duration,
    width: 1920,
    height: 1080,
    hasAudio: kind !== 'image',
    hasVideo: kind !== 'audio',
  };
}

function setup(): Project {
  let p = createProject('t');
  p = addAsset(p, asset('v10', 'video', 10));
  p = addAsset(p, asset('a20', 'audio', 20));
  p = addAsset(p, asset('img', 'image', 0));
  return p;
}

const videoTrack = (p: Project) => p.tracks.find((t) => t.kind === 'video')!.id;

describe('addClip', () => {
  it('appends clips sequentially to the matching track kind', () => {
    let p = setup();
    const a = addClip(p, 'v10');
    p = a.project;
    const b = addClip(p, 'v10');
    p = b.project;
    expect(p.clips[a.clipId].start).toBe(0);
    expect(p.clips[b.clipId].start).toBe(10);
    expect(p.clips[a.clipId].trackId).toBe(videoTrack(p));
    const c = addClip(p, 'a20');
    expect(c.project.tracks.find((t) => t.id === c.project.clips[c.clipId].trackId)!.kind).toBe('audio');
  });

  it('gives images a default duration', () => {
    const { project, clipId } = addClip(setup(), 'img');
    expect(clipDuration(project.clips[clipId])).toBe(5);
  });

  it('creates a new track when dropped onto an occupied spot', () => {
    let p = addClip(setup(), 'v10').project;
    const before = p.tracks.length;
    const r = addClip(p, 'v10', { trackId: videoTrack(p), start: 3 });
    p = r.project;
    expect(p.tracks.length).toBe(before + 1);
    expect(p.clips[r.clipId].start).toBe(3);
    expect(p.clips[r.clipId].trackId).not.toBe(videoTrack(setup()));
  });
});

describe('split', () => {
  it('splits a clip into two contiguous pieces covering the same source', () => {
    const r0 = addClip(setup(), 'v10');
    const r = splitClip(r0.project, r0.clipId, 4);
    const left = r.project.clips[r0.clipId];
    const right = r.project.clips[r.newClipId!];
    expect(left.out).toBeCloseTo(4);
    expect(right.start).toBeCloseTo(4);
    expect(right.in).toBeCloseTo(4);
    expect(right.out).toBeCloseTo(10);
    expect(clipEnd(right)).toBeCloseTo(10);
  });

  it('ignores splits at the clip edges', () => {
    const r0 = addClip(setup(), 'v10');
    expect(splitClip(r0.project, r0.clipId, 0).newClipId).toBeNull();
    expect(splitClip(r0.project, r0.clipId, 10).newClipId).toBeNull();
    expect(splitClip(r0.project, r0.clipId, 15).project).toBe(r0.project);
  });

  it('respects speed when computing the source cut', () => {
    let { project, clipId } = addClip(setup(), 'v10');
    project = { ...project, clips: { ...project.clips, [clipId]: { ...project.clips[clipId], speed: 2 } } };
    expect(clipDuration(project.clips[clipId])).toBe(5);
    const r = splitClip(project, clipId, 2);
    expect(r.project.clips[clipId].out).toBeCloseTo(4);
  });

  it('splitAt with no ids splits everything under the playhead', () => {
    let p = addClip(setup(), 'v10').project;
    p = addClip(p, 'a20').project;
    const r = splitAt(p, 5);
    expect(r.newClipIds).toHaveLength(2);
    expect(Object.keys(r.project.clips)).toHaveLength(4);
  });
});

describe('trim', () => {
  it('cannot extend beyond source media', () => {
    const r = addClip(setup(), 'v10');
    const p = trimClip(r.project, r.clipId, 'end', 50);
    expect(clipEnd(p.clips[r.clipId])).toBeCloseTo(10);
    const p2 = trimClip(p, r.clipId, 'start', -5);
    expect(p2.clips[r.clipId].start).toBe(0);
    expect(p2.clips[r.clipId].in).toBe(0);
  });

  it('trims the start and moves the in-point', () => {
    const r = addClip(setup(), 'v10');
    const p = trimClip(r.project, r.clipId, 'start', 3);
    expect(p.clips[r.clipId].start).toBeCloseTo(3);
    expect(p.clips[r.clipId].in).toBeCloseTo(3);
    expect(clipEnd(p.clips[r.clipId])).toBeCloseTo(10);
  });

  it('cannot overlap the next clip', () => {
    let p = setup();
    const a = addClip(p, 'v10');
    p = a.project;
    p = trimClip(p, a.clipId, 'end', 5);
    const b = addClip(p, 'v10');
    p = b.project; // starts at 5
    p = trimClip(p, a.clipId, 'end', 9);
    expect(clipEnd(p.clips[a.clipId])).toBeCloseTo(5);
  });

  it('images can be extended freely', () => {
    const r = addClip(setup(), 'img');
    const p = trimClip(r.project, r.clipId, 'end', 60);
    expect(clipEnd(p.clips[r.clipId])).toBeCloseTo(60);
  });

  it('never makes a clip shorter than the minimum', () => {
    const r = addClip(setup(), 'v10');
    const p = trimClip(r.project, r.clipId, 'end', -10);
    expect(clipDuration(p.clips[r.clipId])).toBeGreaterThan(0);
  });
});

describe('move', () => {
  it('resolves overlaps to the nearest free spot', () => {
    let p = setup();
    const a = addClip(p, 'v10');
    p = a.project;
    const b = addClip(p, 'v10');
    p = b.project; // [0,10] [10,20]
    p = moveClip(p, b.clipId, videoTrack(p), 4);
    // cannot overlap a -> pushed to 10
    expect(p.clips[b.clipId].start).toBeCloseTo(10);
    p = moveClip(p, b.clipId, videoTrack(p), 25);
    expect(p.clips[b.clipId].start).toBeCloseTo(25);
  });

  it('refuses moving to a track of another kind', () => {
    const r = addClip(setup(), 'v10');
    const audio = r.project.tracks.find((t) => t.kind === 'audio')!.id;
    expect(moveClip(r.project, r.clipId, audio, 0)).toBe(r.project);
  });

  it('never moves before zero', () => {
    const r = addClip(setup(), 'v10', { start: 5 });
    const p = moveClip(r.project, r.clipId, videoTrack(r.project), -3);
    expect(p.clips[r.clipId].start).toBe(0);
  });
});

describe('placement helpers', () => {
  it('canPlace detects overlap', () => {
    const r = addClip(setup(), 'v10');
    const t = videoTrack(r.project);
    expect(canPlace(r.project, t, 5, 2)).toBe(false);
    expect(canPlace(r.project, t, 10, 2)).toBe(true);
  });

  it('nearestFreeStart finds gaps', () => {
    let p = addClip(setup(), 'v10').project; // [0,10]
    const b = addClip(p, 'v10');
    const t = videoTrack(p);
    p = moveClip(b.project, b.clipId, t, 15); // [15,25] -> gap [10,15]
    expect(nearestFreeStart(p, t, 9, 3)).toBeCloseTo(10);
    expect(nearestFreeStart(p, t, 13, 3)).toBeCloseTo(12);
    expect(nearestFreeStart(p, t, 13, 8)).toBeCloseTo(25);
  });
});

describe('delete', () => {
  it('ripple delete closes the gap', () => {
    let p = setup();
    const a = addClip(p, 'v10');
    p = a.project;
    const b = addClip(p, 'v10');
    p = b.project;
    p = rippleDelete(p, [a.clipId]);
    expect(p.clips[a.clipId]).toBeUndefined();
    expect(p.clips[b.clipId].start).toBe(0);
  });

  it('plain delete leaves the gap', () => {
    let p = setup();
    const a = addClip(p, 'v10');
    p = a.project;
    const b = addClip(p, 'v10');
    p = deleteClips(b.project, [a.clipId]);
    expect(p.clips[b.clipId].start).toBe(10);
    expect(deleteClips(p, ['nope'])).toBe(p);
  });

  it('removing an asset removes its clips', () => {
    const r = addClip(setup(), 'v10');
    const p = removeAsset(r.project, 'v10');
    expect(Object.keys(p.clips)).toHaveLength(0);
  });

  it('keeps at least one track of each kind', () => {
    const r = addClip(setup(), 'v10');
    const p = removeTrack(r.project, videoTrack(r.project));
    expect(p.tracks.some((t) => t.kind === 'video')).toBe(true);
    expect(Object.keys(p.clips)).toHaveLength(0);
  });
});

describe('misc', () => {
  it('duplicate places the copy after the original', () => {
    const r = addClip(setup(), 'v10');
    const d = duplicateClip(r.project, r.clipId);
    expect(d.project.clips[d.clipId!].start).toBeCloseTo(10);
    expect(projectDuration(d.project)).toBeCloseTo(20);
  });

  it('clipsAtTime orders bottom track first', () => {
    let p = setup();
    p = addClip(p, 'v10').project;
    const top = addClip(p, 'v10', { trackId: videoTrack(p), start: 2 });
    p = top.project;
    const at = clipsAtTime(p, 3);
    expect(at).toHaveLength(2);
    expect(at[1].id).toBe(top.clipId); // new track is on top -> drawn last
  });

  it('snap picks the closest point within the threshold', () => {
    expect(snap(4.95, [0, 5, 10], 0.1)).toBe(5);
    expect(snap(4.5, [0, 5, 10], 0.1)).toBe(4.5);
    expect(snapRange(2.05, 3, [0, 5], 0.1)).toBeCloseTo(2); // end snaps to 5
    expect(snapRange(0.05, 3, [0, 5], 0.1)).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { clipGainAt, sourceTime } from './compositor';
import { DEFAULT_TRANSFORM, type Clip, type Track } from '../engine/types';

const clip: Clip = {
  id: 'c',
  assetId: 'a',
  trackId: 't',
  start: 10,
  in: 2,
  out: 12,
  speed: 1,
  volume: 1,
  opacity: 1,
  transform: DEFAULT_TRANSFORM,
  fadeIn: 2,
  fadeOut: 4,
};
const track: Track = { id: 't', kind: 'audio', name: 'A', muted: false, hidden: false };

describe('compositor helpers', () => {
  it('maps timeline time to source time', () => {
    expect(sourceTime(clip, 10)).toBe(2);
    expect(sourceTime(clip, 15)).toBe(7);
    expect(sourceTime(clip, 100)).toBe(12);
    expect(sourceTime({ ...clip, speed: 2, out: 22 }, 11)).toBe(4);
  });

  it('applies fades and mute', () => {
    expect(clipGainAt(clip, track, 10)).toBe(0);
    expect(clipGainAt(clip, track, 11)).toBeCloseTo(0.5);
    expect(clipGainAt(clip, track, 15)).toBe(1);
    expect(clipGainAt(clip, track, 18)).toBeCloseTo(0.5);
    expect(clipGainAt(clip, { ...track, muted: true }, 15)).toBe(0);
    expect(clipGainAt({ ...clip, volume: 2 }, track, 15)).toBe(2);
  });
});

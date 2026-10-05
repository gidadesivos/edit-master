import { describe, expect, it } from 'vitest';
import { formatDuration, formatTime, rulerStep, snapToFrame } from './time';

describe('time', () => {
  it('formats timecodes', () => {
    expect(formatTime(0)).toBe('00:00:00');
    expect(formatTime(61.5, 30)).toBe('01:01:15');
    expect(formatTime(3725, 25)).toBe('1:02:05:00');
    expect(formatTime(Number.NaN)).toBe('00:00:00');
  });
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(125.4)).toBe('2:05');
  });
  it('snaps to frames', () => {
    expect(snapToFrame(1.01, 30)).toBeCloseTo(1);
  });
  it('picks ruler steps', () => {
    expect(rulerStep(100)).toBe(1);
    expect(rulerStep(10)).toBe(10);
  });
});

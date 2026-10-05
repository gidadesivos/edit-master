import { describe, expect, it } from 'vitest';
import { addCaptions, splitSegment, wrapLines } from './captions';
import { clipEnd, createProject } from './project';
import { parseProject, serializeProject } from './serialize';

describe('captions', () => {
  it('wraps text at word boundaries', () => {
    expect(wrapLines('um dois três', 7)).toEqual(['um dois', 'três']);
    expect(wrapLines('palavragrandemesmo curta', 5)).toEqual(['palavragrandemesmo', 'curta']);
  });

  it('splits long segments into two-line captions with proportional timing', () => {
    const text = 'Esta é uma frase bem longa que certamente não cabe em apenas duas linhas de legenda na tela do vídeo';
    const parts = splitSegment({ start: 10, end: 20, text });
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].start).toBe(10);
    expect(parts.at(-1)!.end).toBeCloseTo(20);
    for (const p of parts) expect(p.text.split('\n').length).toBeLessThanOrEqual(2);
    expect(parts.map((p) => p.text.replace(/\n/g, ' ')).join(' ')).toBe(text);
  });

  it('creates non-overlapping text clips on a new "Legendas" track', () => {
    const p = createProject();
    const r = addCaptions(p, [
      { start: 0.5, end: 2, text: 'Olá' },
      { start: 1.8, end: 3, text: 'mundo' }, // overlaps the previous one
      { start: 4, end: 4.1, text: 'curto' }, // too short
      { start: 5, end: 6, text: '   ' }, // empty
    ]);
    expect(r.clipIds).toHaveLength(3);
    const clips = r.clipIds.map((id) => r.project.clips[id]);
    const track = r.project.tracks.find((t) => t.id === clips[0].trackId)!;
    expect(track.name).toBe('Legendas');
    expect(r.project.tracks[0].id).toBe(track.id); // top-most
    expect(clips[1].start).toBeGreaterThanOrEqual(clipEnd(clips[0]) - 1e-9);
    expect(clipEnd(clips[2]) - clips[2].start).toBeGreaterThanOrEqual(0.4 - 1e-9);
    expect(clips.every((c) => c.kind === 'text' && c.text!.background === '#000000')).toBe(true);
    expect(parseProject(serializeProject(r.project)).clips[clips[0].id]).toEqual(clips[0]);
  });

  it('does nothing without speech', () => {
    const p = createProject();
    expect(addCaptions(p, []).project).toBe(p);
  });
});

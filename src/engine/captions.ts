/** Turns transcribed speech segments into caption text clips on their own track. */
import { addTrack, makeClip } from './project';
import { DEFAULT_TEXT_STYLE, type Clip, type Project, type Seconds, type TextStyle } from './types';

export interface SpeechSegment {
  start: Seconds;
  end: Seconds;
  text: string;
}

export const CAPTION_STYLE: TextStyle = {
  ...DEFAULT_TEXT_STYLE,
  content: '',
  size: 0.05,
  bold: true,
  color: '#ffffff',
  strokeWidth: 0,
  shadow: false,
  background: '#000000',
  backgroundOpacity: 0.6,
  animIn: 'fade',
  animOut: 'none',
  animInDuration: 0.12,
  animOutDuration: 0,
};

/** Characters per caption line and lines per caption, similar to broadcast subtitle conventions. */
const LINE_CHARS = 38;
const MAX_LINES = 2;
const MIN_DURATION = 0.4;

/** Breaks text into lines of at most `max` characters at word boundaries. */
export function wrapLines(text: string, max = LINE_CHARS): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > max) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** Splits long segments into caption-sized pieces, distributing time by character count. */
export function splitSegment(seg: SpeechSegment): SpeechSegment[] {
  const lines = wrapLines(seg.text);
  if (lines.length <= MAX_LINES) return [{ ...seg, text: lines.join('\n') }];
  const groups: string[][] = [];
  for (let i = 0; i < lines.length; i += MAX_LINES) groups.push(lines.slice(i, i + MAX_LINES));
  const total = lines.reduce((n, l) => n + l.length, 0);
  const dur = Math.max(0, seg.end - seg.start);
  const out: SpeechSegment[] = [];
  let t = seg.start;
  for (const g of groups) {
    const share = g.reduce((n, l) => n + l.length, 0) / total;
    const end = t + dur * share;
    out.push({ start: t, end, text: g.join('\n') });
    t = end;
  }
  return out;
}

/** Adds caption clips on a new top video track named "Legendas". Returns the new clip ids. */
export function addCaptions(p: Project, segments: SpeechSegment[], style: Partial<TextStyle> = {}): { project: Project; clipIds: string[] } {
  const pieces = segments
    .filter((s) => s.text.trim() && Number.isFinite(s.start))
    .sort((a, b) => a.start - b.start)
    .flatMap(splitSegment);
  if (!pieces.length) return { project: p, clipIds: [] };

  const r = addTrack(p, 'video');
  const trackId = r.trackId;
  const tracks = r.project.tracks.map((t) => (t.id === trackId ? { ...t, name: 'Legendas' } : t));
  const clips: Record<string, Clip> = { ...r.project.clips };
  const clipIds: string[] = [];
  let prevEnd = 0;
  for (const seg of pieces) {
    const start = Math.max(seg.start, prevEnd);
    const end = Math.max(seg.end, start + MIN_DURATION);
    const clip = makeClip({
      kind: 'text',
      assetId: '',
      trackId,
      start,
      in: 0,
      out: end - start,
      transform: { x: 0, y: 0.36, scale: 1, rotation: 0 },
      text: { ...CAPTION_STYLE, ...style, content: seg.text },
    });
    clips[clip.id] = clip;
    clipIds.push(clip.id);
    prevEnd = end;
  }
  return { project: { ...r.project, tracks, clips, updatedAt: Date.now() }, clipIds };
}

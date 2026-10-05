/**
 * Mixes the timeline's audio offline (volume, fades, speed, track mute) window by window.
 * Used by the MP4 export and by automatic captions (which need 16 kHz mono).
 */
import { AudioBufferSink, type Input, type WrappedAudioBuffer } from 'mediabunny';
import { clipEnd } from '../engine/project';
import type { Clip, Project, Seconds } from '../engine/types';
import { getMediaFile } from '../media/library';
import { openInput } from '../media/probe';
import { clipGainAt, isAudibleClip, trackMap } from './compositor';

export interface AssetReader {
  input: Input;
  /** First timestamp of the file; source times are relative to it. */
  first: number;
}

/**
 * One continuous decoder per audio clip across all mixing windows. Restarting a decoder for every
 * window shifts some codecs (e.g. Opus) by their pre-skip and produces audible clicks.
 */
interface AudioCursor {
  iterator: AsyncGenerator<WrappedAudioBuffer, void, unknown>;
  /** Decoded buffers that still overlap the current or future windows. */
  pending: Array<{ buffer: AudioBuffer; pos: Seconds; end: Seconds }>;
  done: boolean;
}

export interface AudioMixer {
  /** Mixes [t0, t1). Windows must be requested in increasing, contiguous order. */
  mix(t0: Seconds, t1: Seconds): Promise<AudioBuffer>;
  dispose(): Promise<void>;
}

export function createAudioMixer(
  project: Project,
  sampleRate: number,
  channels: number,
  sharedReader?: (assetId: string) => Promise<AssetReader>,
): AudioMixer {
  const tracks = trackMap(project);
  const audible = Object.values(project.clips).filter((c) => isAudibleClip(project, c));
  const ownReaders = new Map<string, AssetReader>();
  const reader =
    sharedReader ??
    (async (assetId: string) => {
      let r = ownReaders.get(assetId);
      if (!r) {
        const input = openInput(getMediaFile(assetId)!);
        r = { input, first: Math.max(0, await input.getFirstTimestamp()) };
        ownReaders.set(assetId, r);
      }
      return r;
    });
  const cursors = new Map<string, { cursor: AudioCursor | null; first: number }>();

  const cursorFor = async (clip: Clip) => {
    const existing = cursors.get(clip.id);
    if (existing) return existing;
    const r = await reader(clip.assetId);
    const track = await r.input.getPrimaryAudioTrack();
    const entry = {
      first: r.first,
      cursor: track
        ? {
            iterator: new AudioBufferSink(track).buffers(Math.max(0, r.first + clip.in - 0.05), r.first + clip.out),
            pending: [],
            done: false,
          }
        : null,
    };
    cursors.set(clip.id, entry);
    return entry;
  };

  return {
    async mix(t0, t1) {
      const length = Math.max(1, Math.round((t1 - t0) * sampleRate));
      const ac = new OfflineAudioContext(channels, length, sampleRate);
      for (const clip of audible) {
        const end = clipEnd(clip);
        if (end <= t0 || clip.start >= t1) continue;
        const { cursor, first } = await cursorFor(clip);
        if (!cursor) continue;

        // Decode until we have audio covering the whole window.
        while (!cursor.done && (!cursor.pending.length || cursor.pending[cursor.pending.length - 1].end < t1)) {
          const next = await cursor.iterator.next();
          if (next.done) {
            cursor.done = true;
            break;
          }
          const { buffer, timestamp } = next.value;
          const pos = clip.start + (timestamp - first - clip.in) / clip.speed;
          cursor.pending.push({ buffer, pos, end: pos + buffer.duration / clip.speed });
        }

        const gain = ac.createGain();
        gain.connect(ac.destination);
        const tr = tracks.get(clip.trackId);
        const keyTimes = [t0, clip.start + clip.fadeIn, end - clip.fadeOut, t1].filter((x) => x >= t0 && x <= t1).sort((a, b) => a - b);
        // Evaluate inside the clip: outside it the gain is 0, which must not bleed into ramps.
        const g = (k: Seconds) => clipGainAt(clip, tr, Math.min(Math.max(k, clip.start), end - 1e-6));
        gain.gain.setValueAtTime(g(t0), 0);
        for (const k of keyTimes.slice(1)) gain.gain.linearRampToValueAtTime(g(k), k - t0);

        const from = Math.max(t0, clip.start);
        const to = Math.min(t1, end);
        for (const item of cursor.pending) {
          if (item.end <= from || item.pos >= to) continue;
          let pos = item.pos;
          let offset = 0;
          if (pos < from) {
            offset = (from - pos) * clip.speed;
            pos = from;
          }
          const len = Math.min(item.buffer.duration - offset, (to - pos) * clip.speed);
          if (len <= 0) continue;
          const node = ac.createBufferSource();
          node.buffer = item.buffer;
          node.playbackRate.value = clip.speed;
          node.connect(gain);
          node.start(pos - t0, offset, len);
        }
        // Buffers entirely before the next window are no longer needed.
        cursor.pending = cursor.pending.filter((item) => item.end > t1);
      }
      return ac.startRendering();
    },
    async dispose() {
      for (const { cursor } of cursors.values()) await cursor?.iterator.return(undefined).catch(() => undefined);
      for (const r of ownReaders.values()) r.input.dispose();
    },
  };
}

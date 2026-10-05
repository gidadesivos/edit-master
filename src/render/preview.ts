/**
 * Real-time preview. Uses hardware-decoded <video>/<audio> elements kept in sync with the
 * timeline clock and composites them onto a canvas with the shared compositor.
 */
import { clipEnd, projectDuration } from '../engine/project';
import { useEditor } from '../engine/store';
import type { Clip, Project, Seconds } from '../engine/types';
import { getMediaUrl, useMedia } from '../media/library';
import { onSegmenterChange } from './effects';
import {
  clipGainAt,
  isAudibleClip,
  isVisualClip,
  renderFrame,
  sourceTime,
  sourceTimeExtended,
  trackMap,
  visualEnd,
  type FrameSource,
} from './compositor';

/** Seconds before a clip starts at which its element is created and pre-seeked. */
const PRELOAD_AHEAD = 2;
/** Max drift between element and timeline clock while playing before we re-seek. */
const MAX_DRIFT = 0.2;

interface MediaNode {
  assetId: string;
  url: string;
  el: HTMLVideoElement | HTMLAudioElement | HTMLImageElement;
  gain: GainNode | null;
  /** Target time for the element while paused; re-applied after an in-flight seek finishes. */
  pendingSeek: number | null;
}

export class PreviewEngine {
  private ctx: CanvasRenderingContext2D;
  private nodes = new Map<string, MediaNode>();
  private host: HTMLDivElement;
  private audio: AudioContext | null = null;
  private raf = 0;
  private needsDraw = true;
  private clockStart = 0;
  private perfStart = 0;
  private unsub: Array<() => void> = [];
  private disposed = false;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D indisponível');
    this.ctx = ctx;
    // Elements live in an invisible container: some browsers stop decoding detached media.
    this.host = document.createElement('div');
    Object.assign(this.host.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      opacity: '0',
      pointerEvents: 'none',
    });
    document.body.appendChild(this.host);

    this.unsub.push(
      useEditor.subscribe((s, prev) => {
        if (s.playing !== prev.playing) this.onPlayingChange(s.playing);
        if (s.project !== prev.project || s.playhead !== prev.playhead) this.needsDraw = true;
      }),
      onSegmenterChange(() => (this.needsDraw = true)),
      useMedia.subscribe((s, prev) => {
        if (s.revision !== prev.revision) {
          this.dropStaleNodes();
          this.needsDraw = true;
        }
      }),
    );
    this.raf = requestAnimationFrame(this.tick);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unsub.forEach((u) => u());
    for (const id of [...this.nodes.keys()]) this.removeNode(id);
    this.host.remove();
    void this.audio?.close();
  }

  /** Call after the canvas element was resized. */
  invalidate(): void {
    this.needsDraw = true;
  }

  private ensureAudio(): AudioContext | null {
    if (!this.audio) {
      try {
        this.audio = new AudioContext({ latencyHint: 'playback' });
      } catch {
        return null;
      }
    }
    return this.audio;
  }

  private onPlayingChange(playing: boolean): void {
    if (playing) {
      const { playhead, project } = useEditor.getState();
      const duration = projectDuration(project);
      // Pressing play at the end restarts from the beginning.
      this.clockStart = playhead >= duration - 0.01 ? 0 : playhead;
      this.perfStart = performance.now();
      const ac = this.ensureAudio();
      if (ac && ac.state !== 'running') void ac.resume();
    } else {
      for (const n of this.nodes.values()) if (n.el instanceof HTMLMediaElement) n.el.pause();
    }
    this.needsDraw = true;
  }

  private tick = (): void => {
    if (this.disposed) return;
    const state = useEditor.getState();
    if (state.playing) {
      const duration = projectDuration(state.project);
      let t = this.clockStart + (performance.now() - this.perfStart) / 1000;
      if (t >= duration) {
        t = duration;
        state.setPlayhead(t);
        state.setPlaying(false);
      } else {
        state.setPlayhead(t);
      }
      this.sync(state.project, t, true);
      this.draw(state.project, t, true);
    } else if (this.needsDraw) {
      this.sync(state.project, state.playhead, false);
      this.draw(state.project, state.playhead, false);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private wanted(p: Project, t: Seconds, playing: boolean): Clip[] {
    return Object.values(p.clips).filter((c) => {
      if (c.kind === 'text') return false;
      const visual = isVisualClip(p, c);
      if (!visual && !isAudibleClip(p, c)) return false;
      const ahead = playing ? PRELOAD_AHEAD : 0;
      // Visual clips stay alive during the transition of the next clip over them.
      const end = visual ? visualEnd(p, c) : clipEnd(c);
      return c.start - ahead <= t && t < end;
    });
  }

  private makeNode(p: Project, clip: Clip): MediaNode | null {
    const asset = p.assets[clip.assetId];
    const url = getMediaUrl(clip.assetId);
    if (!asset || !url) return null;
    let el: MediaNode['el'];
    let gain: GainNode | null = null;
    if (asset.kind === 'image') {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      img.onload = () => (this.needsDraw = true);
      el = img;
    } else {
      const media = document.createElement(asset.kind === 'video' ? 'video' : 'audio');
      media.preload = 'auto';
      media.crossOrigin = 'anonymous';
      if (media instanceof HTMLVideoElement) {
        media.playsInline = true;
        media.disablePictureInPicture = true;
      }
      media.src = url;
      const redraw = () => (this.needsDraw = true);
      media.addEventListener('loadeddata', () => {
        // A seek requested before metadata was available may be ignored; re-apply it.
        const n = this.nodes.get(clip.id);
        if (n && n.pendingSeek !== null) media.currentTime = n.pendingSeek;
        redraw();
      });
      media.addEventListener('seeked', () => {
        const n = this.nodes.get(clip.id);
        if (n && n.pendingSeek !== null && Math.abs(media.currentTime - n.pendingSeek) > 0.01) {
          media.currentTime = n.pendingSeek;
        } else if (n) n.pendingSeek = null;
        redraw();
      });
      const ac = this.ensureAudio();
      if (ac && asset.hasAudio) {
        try {
          const src = ac.createMediaElementSource(media);
          gain = ac.createGain();
          src.connect(gain).connect(ac.destination);
        } catch {
          gain = null;
        }
      } else if (!asset.hasAudio) {
        media.muted = true;
      }
      el = media;
    }
    this.host.appendChild(el);
    return { assetId: clip.assetId, url, el, gain, pendingSeek: null };
  }

  private removeNode(id: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    if (n.el instanceof HTMLMediaElement) {
      n.el.pause();
      n.el.removeAttribute('src');
      n.el.load();
    }
    n.gain?.disconnect();
    n.el.remove();
    this.nodes.delete(id);
  }

  /** Removes nodes whose file was replaced (relinked) so they get recreated with the new URL. */
  private dropStaleNodes(): void {
    for (const [id, n] of this.nodes) if (getMediaUrl(n.assetId) !== n.url) this.removeNode(id);
  }

  private sync(p: Project, t: Seconds, playing: boolean): void {
    const wanted = this.wanted(p, t, playing);
    const keep = new Set(wanted.map((c) => c.id));
    for (const id of [...this.nodes.keys()]) if (!keep.has(id)) this.removeNode(id);

    const tracks = trackMap(p);
    for (const clip of wanted) {
      let node = this.nodes.get(clip.id);
      if (node && node.assetId !== clip.assetId) {
        this.removeNode(clip.id);
        node = undefined;
      }
      if (!node) {
        const created = this.makeNode(p, clip);
        if (!created) continue;
        node = created;
        this.nodes.set(clip.id, node);
      }
      const el = node.el;
      if (!(el instanceof HTMLMediaElement)) continue;

      const active = clip.start <= t;
      const inTail = t >= clipEnd(clip);
      const target = inTail ? sourceTimeExtended(p, clip, t) : sourceTime(clip, active ? t : clip.start);
      const gain = isAudibleClip(p, clip) ? clipGainAt(clip, tracks.get(clip.trackId), t) : 0;
      if (node.gain) node.gain.gain.value = gain;
      else el.volume = Math.min(1, gain);
      const rate = Math.min(4, Math.max(0.25, clip.speed));
      if (el.playbackRate !== rate) el.playbackRate = rate;

      if (playing && active) {
        if (el.paused) {
          if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
          void el.play().catch(() => undefined);
        } else if (Math.abs(el.currentTime - target) > MAX_DRIFT * clip.speed) {
          el.currentTime = target;
        }
      } else {
        if (!el.paused) el.pause();
        const fps = p.settings.fps || 30;
        if (Math.abs(el.currentTime - target) > 0.5 / fps) {
          if (el.seeking) node.pendingSeek = target;
          else {
            node.pendingSeek = target;
            el.currentTime = target;
          }
        }
      }
    }
  }

  private draw(p: Project, t: Seconds, playing: boolean): void {
    const provider = (clip: Clip): FrameSource | null | 'pending' => {
      const node = this.nodes.get(clip.id);
      if (!node) return playing ? null : 'pending';
      const el = node.el;
      if (el instanceof HTMLVideoElement) {
        // Keep the previous frame on screen instead of flashing black while a seek is in flight.
        if (el.readyState < 2 || (!playing && el.seeking)) return playing ? null : 'pending';
        return { source: el, width: el.videoWidth, height: el.videoHeight };
      }
      if (el instanceof HTMLImageElement) {
        if (!el.complete || !el.naturalWidth) return playing ? null : 'pending';
        return { source: el, width: el.naturalWidth, height: el.naturalHeight };
      }
      return null;
    };
    const { width, height } = this.canvas;
    if (renderFrame(this.ctx, p, t, width, height, provider)) this.needsDraw = false;
  }
}

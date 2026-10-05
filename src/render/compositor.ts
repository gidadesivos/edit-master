/**
 * Shared frame compositor. Both the live preview and the final export call `renderFrame`,
 * so what you see in the editor is exactly what ends up in the exported file.
 */
import { valueAt } from '../engine/keyframes';
import { clipDuration, clipEnd, previousAdjacent, transitionTails } from '../engine/project';
import { applyChromaKey, removeBackground } from './effects';
import type { Clip, FilterPreset, Project, Seconds, TextAnimation, Track, TransitionType } from '../engine/types';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface FrameSource {
  source: CanvasImageSource;
  width: number;
  height: number;
}

/** Provides the picture of a media clip at a source time. 'pending' = not ready yet (preview keeps the old frame). */
export type SourceProvider = (clip: Clip, srcTime: Seconds) => FrameSource | null | 'pending';

export interface FrameItem {
  clip: Clip;
  /** Seconds since the clip start. */
  local: Seconds;
  /** Position in the source media (media clips). */
  srcTime: Seconds;
  transition: { type: TransitionType; p: number; role: 'in' | 'out' } | null;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (u: number) => u * u * (3 - 2 * u);

// ---------------------------------------------------------------------------------------------
// Clip classification and time mapping

const trackCache = new WeakMap<Project, Map<string, Track>>();
export function trackMap(p: Project): Map<string, Track> {
  let m = trackCache.get(p);
  if (!m) {
    m = new Map(p.tracks.map((t) => [t.id, t]));
    trackCache.set(p, m);
  }
  return m;
}

const tailCache = new WeakMap<Project, Map<string, Seconds>>();
/** Cached `transitionTails` per project instance. */
export function tails(p: Project): Map<string, Seconds> {
  let m = tailCache.get(p);
  if (!m) {
    m = transitionTails(p);
    tailCache.set(p, m);
  }
  return m;
}

/** Whether a clip produces a picture (video/image/text on a visible video track). */
export function isVisualClip(p: Project, clip: Clip): boolean {
  const track = trackMap(p).get(clip.trackId);
  if (!track || track.kind !== 'video' || track.hidden) return false;
  if (clip.kind === 'text') return true;
  return !!p.assets[clip.assetId]?.hasVideo;
}

export function isAudibleClip(p: Project, clip: Clip): boolean {
  if (clip.kind === 'text') return false;
  const asset = p.assets[clip.assetId];
  const track = trackMap(p).get(clip.trackId);
  return !!asset && !!track && !track.muted && asset.hasAudio && clip.volume > 0;
}

/** Position inside the source media for a timeline time (clamped to the clip). */
export function sourceTime(clip: Clip, t: Seconds): Seconds {
  const local = Math.min(Math.max(t - clip.start, 0), clipDuration(clip));
  return clip.in + local * clip.speed;
}

/**
 * Like `sourceTime`, but continues past the clip end (used while the next clip transitions over it),
 * limited to the source media length.
 */
export function sourceTimeExtended(p: Project, clip: Clip, t: Seconds): Seconds {
  const asset = p.assets[clip.assetId];
  const raw = clip.in + Math.max(0, t - clip.start) * clip.speed;
  if (!asset || asset.kind !== 'video') return raw;
  return Math.min(raw, Math.max(0, asset.duration - 0.001));
}

/** Last timeline time at which a clip is visible (its end plus any transition tail). */
export function visualEnd(p: Project, clip: Clip): Seconds {
  return clipEnd(clip) + (tails(p).get(clip.id) ?? 0);
}

/** Audio gain for a clip at timeline time `t`, including fades and track mute. */
export function clipGainAt(clip: Clip, track: Track | undefined, t: Seconds): number {
  if (!track || track.muted) return 0;
  const end = clipEnd(clip);
  if (t < clip.start || t >= end) return 0;
  let g = clip.volume;
  if (clip.fadeIn > 0) g *= Math.min(1, Math.max(0, (t - clip.start) / clip.fadeIn));
  if (clip.fadeOut > 0) g *= Math.min(1, Math.max(0, (end - t) / clip.fadeOut));
  return g;
}

/** Everything to draw at time `t`, bottom layer first. */
export function frameItems(p: Project, t: Seconds): FrameItem[] {
  const items: FrameItem[] = [];
  const byTrack = new Map<string, Clip[]>();
  for (const c of Object.values(p.clips)) {
    if (!isVisualClip(p, c)) continue;
    const list = byTrack.get(c.trackId);
    if (list) list.push(c);
    else byTrack.set(c.trackId, [c]);
  }
  for (let i = p.tracks.length - 1; i >= 0; i--) {
    const clips = byTrack.get(p.tracks[i].id);
    if (!clips) continue;
    clips.sort((a, b) => a.start - b.start);
    for (const c of clips) {
      if (!(c.start <= t && t < clipEnd(c))) continue;
      const tr = c.transitionIn;
      if (tr && t < c.start + tr.duration) {
        const progress = clamp01((t - c.start) / tr.duration);
        const prev = previousAdjacent(p, c);
        if (prev && isVisualClip(p, prev)) {
          items.push({
            clip: prev,
            local: t - prev.start,
            srcTime: sourceTimeExtended(p, prev, t),
            transition: { type: tr.type, p: progress, role: 'out' },
          });
        }
        items.push({ clip: c, local: t - c.start, srcTime: sourceTime(c, t), transition: { type: tr.type, p: progress, role: 'in' } });
      } else {
        items.push({ clip: c, local: t - c.start, srcTime: sourceTime(c, t), transition: null });
      }
    }
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// Filters and colour

export const FILTER_PRESETS: Record<FilterPreset, { label: string; css: string; temperature: number; vignette: number }> = {
  none: { label: 'Original', css: '', temperature: 0, vignette: 0 },
  bw: { label: 'P&B', css: 'grayscale(1) contrast(1.1)', temperature: 0, vignette: 0 },
  sepia: { label: 'Sépia', css: 'sepia(0.85)', temperature: 0, vignette: 0.2 },
  vintage: { label: 'Vintage', css: 'sepia(0.35) contrast(0.9) saturate(0.8) brightness(1.05)', temperature: 0.2, vignette: 0.45 },
  warm: { label: 'Quente', css: 'saturate(1.1)', temperature: 0.55, vignette: 0 },
  cool: { label: 'Frio', css: 'saturate(0.95)', temperature: -0.55, vignette: 0 },
  vivid: { label: 'Vívido', css: 'saturate(1.5) contrast(1.1)', temperature: 0, vignette: 0 },
  fade: { label: 'Desbotado', css: 'contrast(0.8) brightness(1.1) saturate(0.75)', temperature: 0, vignette: 0 },
  dramatic: { label: 'Dramático', css: 'contrast(1.4) saturate(0.7) brightness(0.9)', temperature: 0, vignette: 0.5 },
};

/** CSS filter string for a clip; blur is scaled to the canvas height so preview and export match. */
export function filterCss(clip: Clip, canvasH: number): string {
  const a = clip.adjust;
  const parts = [FILTER_PRESETS[clip.filter]?.css ?? ''];
  if (a.brightness) parts.push(`brightness(${(1 + a.brightness).toFixed(3)})`);
  if (a.contrast) parts.push(`contrast(${(1 + a.contrast).toFixed(3)})`);
  if (a.saturation) parts.push(`saturate(${(1 + a.saturation).toFixed(3)})`);
  if (a.hue) parts.push(`hue-rotate(${a.hue.toFixed(1)}deg)`);
  if (a.blur > 0) parts.push(`blur(${(a.blur * 0.02 * canvasH).toFixed(2)}px)`);
  return parts.filter(Boolean).join(' ') || 'none';
}

export function toneOf(clip: Clip): { temperature: number; vignette: number } {
  const pr = FILTER_PRESETS[clip.filter] ?? FILTER_PRESETS.none;
  return {
    temperature: Math.max(-1, Math.min(1, pr.temperature + clip.adjust.temperature)),
    vignette: clamp01(pr.vignette + clip.adjust.vignette),
  };
}

let scratch: OffscreenCanvas | null = null;
function getScratch(w: number, h: number): OffscreenCanvasRenderingContext2D {
  if (!scratch || scratch.width !== w || scratch.height !== h) scratch = new OffscreenCanvas(w, h);
  const c = scratch.getContext('2d')!;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  c.filter = 'none';
  c.clearRect(0, 0, w, h);
  return c;
}

// ---------------------------------------------------------------------------------------------
// Transitions

interface Effect {
  dx: number;
  dy: number;
  scale: number;
  alpha: number;
  clip?: (c: Ctx2D) => void;
}

export const TRANSITIONS: Record<TransitionType, string> = {
  fade: 'Dissolver',
  black: 'Escurecer',
  'slide-left': 'Deslizar ←',
  'slide-up': 'Deslizar ↑',
  'wipe-left': 'Cortina',
  zoom: 'Zoom',
  circle: 'Círculo',
};

function transitionEffect(type: TransitionType, role: 'in' | 'out', p: number, W: number, H: number): Effect {
  const e = smooth(p);
  const fx: Effect = { dx: 0, dy: 0, scale: 1, alpha: 1 };
  switch (type) {
    case 'fade':
      if (role === 'in') fx.alpha = e;
      break;
    case 'black':
      fx.alpha = role === 'in' ? clamp01(2 * e - 1) : clamp01(1 - 2 * e);
      break;
    case 'slide-left':
      fx.dx = role === 'in' ? (1 - e) * W : -e * W;
      break;
    case 'slide-up':
      fx.dy = role === 'in' ? (1 - e) * H : -e * H;
      break;
    case 'wipe-left':
      if (role === 'in') {
        fx.clip = (c) => {
          c.beginPath();
          c.rect(W * (1 - e), 0, W * e + 1, H);
          c.clip();
        };
      }
      break;
    case 'zoom':
      if (role === 'in') {
        fx.scale = 1.3 - 0.3 * e;
        fx.alpha = e;
      } else fx.scale = 1 + 0.15 * e;
      break;
    case 'circle':
      if (role === 'in') {
        fx.clip = (c) => {
          c.beginPath();
          c.arc(W / 2, H / 2, Math.max(0.5, (e * Math.hypot(W, H)) / 2), 0, Math.PI * 2);
          c.clip();
        };
      }
      break;
  }
  return fx;
}

// ---------------------------------------------------------------------------------------------
// Text

export const FONTS = ['Segoe UI', 'Arial', 'Impact', 'Georgia', 'Times New Roman', 'Courier New', 'Comic Sans MS', 'Trebuchet MS', 'Verdana'];

export const TEXT_ANIMATIONS: Record<TextAnimation, string> = {
  none: 'Nenhuma',
  fade: 'Aparecer',
  'slide-up': 'Subir',
  'slide-down': 'Descer',
  pop: 'Pop',
  typewriter: 'Máquina de escrever',
  blur: 'Desfoque',
};

interface TextAnim {
  alpha: number;
  dy: number;
  scale: number;
  chars: number; // 0..1 fraction of characters shown
  blur: number; // px
}

function applyTextAnim(anim: TextAnimation, p: number, entering: boolean, H: number, out: TextAnim): void {
  if (anim === 'none' || p >= 1) return;
  const e = smooth(clamp01(p));
  switch (anim) {
    case 'fade':
      out.alpha *= e;
      break;
    case 'slide-up':
      out.dy += (entering ? 1 : -1) * (1 - e) * 0.06 * H;
      out.alpha *= e;
      break;
    case 'slide-down':
      out.dy += (entering ? -1 : 1) * (1 - e) * 0.06 * H;
      out.alpha *= e;
      break;
    case 'pop': {
      // Overshoot on the way in for a playful bounce.
      const back = entering ? 1 + 2.2 * Math.pow(e - 1, 3) + 1.2 * Math.pow(e - 1, 2) : e;
      out.scale *= 0.5 + 0.5 * back;
      out.alpha *= clamp01(p * 2);
      break;
    }
    case 'typewriter':
      out.chars = Math.min(out.chars, clamp01(p));
      break;
    case 'blur':
      out.blur += (1 - e) * 0.02 * H;
      out.alpha *= e;
      break;
  }
}

function roundRect(c: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function hexToRgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Draws a text clip centred at the current origin (transform already applied). */
function drawTextContent(c: Ctx2D, clip: Clip, local: Seconds, H: number): void {
  const st = clip.text!;
  const dur = clipDuration(clip);
  const anim: TextAnim = { alpha: 1, dy: 0, scale: 1, chars: 1, blur: 0 };
  if (st.animInDuration > 0) applyTextAnim(st.animIn, local / st.animInDuration, true, H, anim);
  if (st.animOutDuration > 0) applyTextAnim(st.animOut, (dur - local) / st.animOutDuration, false, H, anim);
  if (anim.alpha <= 0.001) return;

  const fontPx = Math.max(1, st.size * H);
  c.font = `${st.italic ? 'italic ' : ''}${st.bold ? '700' : '400'} ${fontPx}px "${st.font}", "Segoe UI", Arial, sans-serif`;
  c.textBaseline = 'middle';
  const lines = st.content.split('\n');
  const lineH = fontPx * 1.25;
  const widths = lines.map((l) => c.measureText(l).width);
  const blockW = Math.max(1, ...widths);
  const blockH = lines.length * lineH;

  c.globalAlpha *= anim.alpha;
  c.translate(0, anim.dy);
  if (anim.scale !== 1) c.scale(anim.scale, anim.scale);
  if (anim.blur > 0) c.filter = `${c.filter === 'none' ? '' : c.filter} blur(${anim.blur.toFixed(2)}px)`;

  if (st.background) {
    const pad = fontPx * 0.3;
    c.fillStyle = hexToRgba(st.background, st.backgroundOpacity);
    roundRect(c, -blockW / 2 - pad, -blockH / 2 - pad * 0.6, blockW + pad * 2, blockH + pad * 1.2, fontPx * 0.2);
    c.fill();
  }

  // Typewriter: reveal characters progressively across all lines.
  const total = lines.reduce((n, l) => n + l.length, 0);
  let budget = anim.chars >= 1 ? Infinity : Math.floor(total * anim.chars);
  const shown = lines.map((l) => {
    const take = Math.max(0, Math.min(l.length, budget));
    budget -= take;
    return l.slice(0, take);
  });

  c.textAlign = st.align;
  const lineX = st.align === 'left' ? -blockW / 2 : st.align === 'right' ? blockW / 2 : 0;
  const yFor = (i: number) => -blockH / 2 + lineH * (i + 0.5);

  if (st.shadow) {
    c.shadowColor = 'rgba(0,0,0,0.6)';
    c.shadowBlur = fontPx * 0.15;
    c.shadowOffsetY = fontPx * 0.05;
  }
  if (st.strokeWidth > 0) {
    c.lineJoin = 'round';
    c.miterLimit = 2;
    c.lineWidth = st.strokeWidth * fontPx * 2;
    c.strokeStyle = st.strokeColor;
    shown.forEach((l, i) => l && c.strokeText(l, lineX, yFor(i)));
    c.shadowColor = 'transparent';
  }
  c.fillStyle = st.color;
  shown.forEach((l, i) => l && c.fillText(l, lineX, yFor(i)));
}

// ---------------------------------------------------------------------------------------------
// Drawing

function drawItem(ctx: Ctx2D, item: FrameItem, src: FrameSource | null, W: number, H: number): void {
  const { clip, local } = item;
  if (clip.kind === 'media' && (!src || src.width <= 0 || src.height <= 0)) return;
  let alpha = clamp01(valueAt(clip, 'opacity', local));
  const x = valueAt(clip, 'x', local);
  const y = valueAt(clip, 'y', local);
  let scale = valueAt(clip, 'scale', local);
  const rotation = valueAt(clip, 'rotation', local);
  let dx = 0;
  let dy = 0;
  let clipPath: Effect['clip'];
  if (item.transition) {
    const fx = transitionEffect(item.transition.type, item.transition.role, item.transition.p, W, H);
    alpha *= fx.alpha;
    scale *= fx.scale;
    dx = fx.dx;
    dy = fx.dy;
    clipPath = fx.clip;
  }
  if (alpha <= 0.001 || scale <= 0) return;

  const tone = toneOf(clip);
  const isolated = tone.temperature !== 0 || tone.vignette > 0;
  const target: Ctx2D = isolated ? getScratch(W, H) : ctx;

  target.save();
  if (!isolated) {
    clipPath?.(target);
    target.globalAlpha = alpha;
  }
  target.filter = filterCss(clip, H);
  target.translate(W / 2 + x * W + dx, H / 2 + y * H + dy);
  if (rotation) target.rotate((rotation * Math.PI) / 180);
  if (clip.kind === 'text' && clip.text) {
    target.scale(scale, scale);
    drawTextContent(target, clip, local, H);
  } else if (src) {
    if (clip.chromaKey) src = applyChromaKey(src, clip.chromaKey);
    if (clip.removeBg) src = removeBackground(src, clip.id);
    const fit = Math.min(W / src.width, H / src.height) * scale;
    const w = src.width * fit;
    const h = src.height * fit;
    target.imageSmoothingQuality = 'high';
    target.drawImage(src.source, -w / 2, -h / 2, w, h);
  }
  target.restore();

  if (isolated) {
    const sc = target as OffscreenCanvasRenderingContext2D;
    sc.save();
    sc.globalCompositeOperation = 'source-atop';
    if (tone.temperature !== 0) {
      const a = 0.22 * Math.abs(tone.temperature);
      sc.fillStyle = tone.temperature > 0 ? `rgba(255,140,40,${a})` : `rgba(40,140,255,${a})`;
      sc.fillRect(0, 0, W, H);
    }
    if (tone.vignette > 0) {
      const r = Math.hypot(W, H) / 2;
      const g = sc.createRadialGradient(W / 2, H / 2, r * 0.35, W / 2, H / 2, r);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${0.85 * tone.vignette})`);
      sc.fillStyle = g;
      sc.fillRect(0, 0, W, H);
    }
    sc.restore();
    ctx.save();
    clipPath?.(ctx);
    ctx.globalAlpha = alpha;
    ctx.drawImage(sc.canvas, 0, 0);
    ctx.restore();
  }
}

/**
 * Renders the timeline at time `t`. Returns false (and draws nothing) when a source is still
 * loading, so the preview can keep showing the previous frame instead of flashing.
 */
export function renderFrame(ctx: Ctx2D, p: Project, t: Seconds, W: number, H: number, provider: SourceProvider): boolean {
  const items = frameItems(p, t);
  const sources: Array<FrameSource | null> = [];
  for (const item of items) {
    if (item.clip.kind === 'text') {
      sources.push(null);
      continue;
    }
    const s = provider(item.clip, item.srcTime);
    if (s === 'pending') return false;
    sources.push(s);
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.fillStyle = p.settings.background;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  items.forEach((item, i) => drawItem(ctx, item, sources[i], W, H));
  return true;
}

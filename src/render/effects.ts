/**
 * Per-source pixel effects that need more than canvas filters:
 *  - chroma key (green/blue screen) — WebGL2 shader
 *  - background removal — MediaPipe selfie segmentation, running fully on-device
 *
 * Both are synchronous once initialised so the shared compositor can use them for preview and export.
 * The returned canvases are reused between calls: draw them immediately.
 */
import type { ChromaKey } from '../engine/types';
import type { FrameSource } from './compositor';

// ---------------------------------------------------------------------------------------------
// Chroma key

const VERT = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  uv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

// Distance in the chroma (Cb/Cr) plane, like OBS's chroma key: robust to lighting changes.
const FRAG = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform vec3 keyColor;
uniform float similarity;
uniform float smoothness;
uniform float spill;
in vec2 uv;
out vec4 outColor;
vec2 chroma(vec3 c) {
  return vec2(-0.1687 * c.r - 0.3313 * c.g + 0.5 * c.b, 0.5 * c.r - 0.4187 * c.g - 0.0813 * c.b);
}
void main() {
  vec4 rgba = texture(tex, uv);
  float d = distance(chroma(rgba.rgb), chroma(keyColor));
  float base = d - similarity;
  float alpha = rgba.a * pow(clamp(base / smoothness, 0.0, 1.0), 1.5);
  float spillVal = pow(clamp(base / spill, 0.0, 1.0), 1.5);
  float gray = dot(rgba.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 rgb = mix(vec3(gray), rgba.rgb, spillVal);
  outColor = vec4(rgb * alpha, alpha);
}`;

interface GlState {
  canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext;
  tex: WebGLTexture;
  loc: Record<'keyColor' | 'similarity' | 'smoothness' | 'spill', WebGLUniformLocation | null>;
}

let glState: GlState | null | undefined;

function initGl(): GlState | null {
  if (glState !== undefined) return glState;
  try {
    const canvas = new OffscreenCanvas(2, 2);
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 indisponível');
    const shader = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(prog, 'pos');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const loc = {
      keyColor: gl.getUniformLocation(prog, 'keyColor'),
      similarity: gl.getUniformLocation(prog, 'similarity'),
      smoothness: gl.getUniformLocation(prog, 'smoothness'),
      spill: gl.getUniformLocation(prog, 'spill'),
    };
    glState = { canvas, gl, tex, loc };
  } catch (err) {
    console.warn('chroma key unavailable', err);
    glState = null;
  }
  return glState;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Largest dimension processed by the effects (keeps 4K sources fast). */
const MAX_EFFECT_SIZE = 2048;

function fitSize(w: number, h: number, max = MAX_EFFECT_SIZE): [number, number] {
  const s = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

export function applyChromaKey(src: FrameSource, key: ChromaKey): FrameSource {
  const st = initGl();
  if (!st) return src;
  const { gl, canvas, loc } = st;
  const [w, h] = fitSize(src.width, src.height);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, w, h);
  gl.bindTexture(gl.TEXTURE_2D, st.tex);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src.source as TexImageSource);
  } catch {
    return src;
  }
  gl.uniform3fv(loc.keyColor, hexToRgb(key.color));
  gl.uniform1f(loc.similarity, key.similarity * 0.5);
  gl.uniform1f(loc.smoothness, Math.max(0.002, key.smoothness * 0.5));
  gl.uniform1f(loc.spill, Math.max(0.002, key.spill * 0.5));
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return { source: canvas, width: w, height: h };
}

// ---------------------------------------------------------------------------------------------
// Background removal (people), on-device with MediaPipe

type Segmenter = import('@mediapipe/tasks-vision').ImageSegmenter;

export type SegmenterStatus = 'idle' | 'loading' | 'ready' | 'error';
let segmenter: Segmenter | null = null;
let loading: Promise<void> | null = null;
let status: SegmenterStatus = 'idle';
let lastError = '';
const listeners = new Set<() => void>();

export const segmenterState = () => ({ status, error: lastError });
export function onSegmenterChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function setStatus(s: SegmenterStatus, err = '') {
  status = s;
  lastError = err;
  listeners.forEach((l) => l());
}

/** Loads the segmentation model (bundled with the app — no download). */
export function ensureSegmenter(): Promise<void> {
  if (segmenter) return Promise.resolve();
  if (loading) return loading;
  setStatus('loading');
  loading = (async () => {
    const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision');
    const base = new URL('./', document.baseURI).href;
    const fileset = await FilesetResolver.forVisionTasks(base + 'mediapipe');
    const create = (delegate: 'GPU' | 'CPU') =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: base + 'models/selfie_segmenter.tflite', delegate },
        runningMode: 'IMAGE',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    try {
      segmenter = await create('GPU');
    } catch {
      segmenter = await create('CPU');
    }
    setStatus('ready');
  })().catch((err) => {
    loading = null;
    setStatus('error', err instanceof Error ? err.message : String(err));
    throw err;
  });
  return loading;
}

const SEG_INPUT = 512;
let segInput: OffscreenCanvas | null = null;
let maskCanvas: OffscreenCanvas | null = null;
let outCanvas: OffscreenCanvas | null = null;
/** Previous mask per clip, blended with the new one to reduce flicker between frames. */
const prevMasks = new Map<string, Float32Array>();

/**
 * Returns the source with its background made transparent, or the source untouched while the model
 * is still loading (the preview redraws once it is ready).
 */
export function removeBackground(src: FrameSource, key: string): FrameSource {
  if (!segmenter) {
    if (status === 'idle') void ensureSegmenter().catch(() => undefined);
    return src;
  }
  const [iw, ih] = fitSize(src.width, src.height, SEG_INPUT);
  if (!segInput) segInput = new OffscreenCanvas(iw, ih);
  if (segInput.width !== iw || segInput.height !== ih) {
    segInput.width = iw;
    segInput.height = ih;
  }
  const ic = segInput.getContext('2d')!;
  ic.clearRect(0, 0, iw, ih);
  ic.drawImage(src.source, 0, 0, iw, ih);

  let mask: Float32Array;
  let mw: number;
  let mh: number;
  try {
    const result = segmenter.segment(segInput);
    const m = result.confidenceMasks?.[0];
    if (!m) return src;
    mask = m.getAsFloat32Array().slice();
    mw = m.width;
    mh = m.height;
    result.close();
  } catch (err) {
    console.warn('segmentation failed', err);
    return src;
  }

  const prev = prevMasks.get(key);
  if (prev && prev.length === mask.length) {
    for (let i = 0; i < mask.length; i++) mask[i] = mask[i] * 0.7 + prev[i] * 0.3;
  }
  prevMasks.set(key, mask);

  if (!maskCanvas) maskCanvas = new OffscreenCanvas(mw, mh);
  if (maskCanvas.width !== mw || maskCanvas.height !== mh) {
    maskCanvas.width = mw;
    maskCanvas.height = mh;
  }
  const img = new ImageData(mw, mh);
  for (let i = 0; i < mask.length; i++) {
    // Sharpen the soft confidence a little so edges are clean but not jagged.
    const a = Math.min(1, Math.max(0, (mask[i] - 0.25) / 0.5));
    img.data[i * 4 + 3] = a * 255;
  }
  maskCanvas.getContext('2d')!.putImageData(img, 0, 0);

  const [ow, oh] = fitSize(src.width, src.height);
  if (!outCanvas) outCanvas = new OffscreenCanvas(ow, oh);
  if (outCanvas.width !== ow || outCanvas.height !== oh) {
    outCanvas.width = ow;
    outCanvas.height = oh;
  }
  const oc = outCanvas.getContext('2d')!;
  oc.globalCompositeOperation = 'source-over';
  oc.clearRect(0, 0, ow, oh);
  oc.drawImage(src.source, 0, 0, ow, oh);
  oc.globalCompositeOperation = 'destination-in';
  oc.imageSmoothingEnabled = true;
  oc.imageSmoothingQuality = 'high';
  oc.drawImage(maskCanvas, 0, 0, ow, oh);
  oc.globalCompositeOperation = 'source-over';
  return { source: outCanvas, width: ow, height: oh };
}

/** Clears temporal state (e.g. when seeking or starting an export). */
export function resetEffectsState(): void {
  prevMasks.clear();
}

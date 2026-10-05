import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input } from 'mediabunny';
import { uid } from '../engine/project';
import type { MediaAsset, MediaKind } from '../engine/types';

export class UnsupportedMediaError extends Error {}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

export function openInput(file: Blob): Input {
  return new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
}

export function guessKind(file: File): MediaKind | null {
  if (file.type.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'image';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('video/')) return 'video';
  return null;
}

/** Reads metadata of a file and builds a MediaAsset. Throws UnsupportedMediaError with a friendly message. */
export async function probeFile(file: File): Promise<MediaAsset> {
  const base = { id: uid(), name: file.name, size: file.size, lastModified: file.lastModified };

  if (guessKind(file) === 'image') {
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(file);
    } catch {
      throw new UnsupportedMediaError(`Não foi possível abrir a imagem "${file.name}".`);
    }
    const asset: MediaAsset = {
      ...base,
      kind: 'image',
      duration: 0,
      width: bmp.width,
      height: bmp.height,
      hasAudio: false,
      hasVideo: true,
    };
    bmp.close();
    return asset;
  }

  const input = openInput(file);
  try {
    if (!(await input.canRead())) {
      throw new UnsupportedMediaError(`Formato de "${file.name}" não suportado. Use MP4, MOV, WebM, MKV, MP3, WAV, M4A, OGG ou FLAC.`);
    }
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    const videoOk = video ? await video.canDecode() : false;
    const audioOk = audio ? await audio.canDecode() : false;

    if (video && !videoOk) {
      const codec = await video.getCodec();
      throw new UnsupportedMediaError(
        `O codec de vídeo ${codec ?? 'desconhecido'} de "${file.name}" não é suportado neste computador.` +
          (codec === 'hevc' ? ' Instale a "Extensão de Vídeo HEVC" da Microsoft Store ou converta para H.264.' : ''),
      );
    }
    if (!video && !audioOk) {
      throw new UnsupportedMediaError(`"${file.name}" não contém áudio ou vídeo reproduzível.`);
    }

    // Timestamps are normalized so that 0 is the first presented sample (matches HTMLMediaElement.currentTime).
    const duration = (await input.computeDuration()) - Math.max(0, await input.getFirstTimestamp());
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new UnsupportedMediaError(`Não foi possível ler a duração de "${file.name}".`);
    }
    return {
      ...base,
      kind: video ? 'video' : 'audio',
      duration,
      width: video ? await video.getDisplayWidth() : 0,
      height: video ? await video.getDisplayHeight() : 0,
      hasAudio: audioOk,
      hasVideo: !!video,
    };
  } catch (err) {
    if (err instanceof UnsupportedMediaError) throw err;
    throw new UnsupportedMediaError(`Erro ao ler "${file.name}": ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    input.dispose();
  }
}

async function canvasToUrl(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string> {
  const blob =
    canvas instanceof OffscreenCanvas
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
      : await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', 0.7));
  return URL.createObjectURL(blob);
}

export const THUMB_HEIGHT = 72;

/** Evenly spaced thumbnails (blob URLs) for the media bin and the timeline filmstrip. */
export async function generateThumbnails(file: File, asset: MediaAsset, count: number): Promise<string[]> {
  if (asset.kind === 'audio') return [];
  if (asset.kind === 'image') {
    const bmp = await createImageBitmap(file, { resizeHeight: THUMB_HEIGHT * 2, resizeQuality: 'medium' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close();
    return [await canvasToUrl(c)];
  }
  const input = openInput(file);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return [];
    const sink = new CanvasSink(track, { height: THUMB_HEIGHT * 2 });
    const first = await track.getFirstTimestamp();
    const times = Array.from({ length: count }, (_, i) => first + ((i + 0.5) / count) * asset.duration);
    const urls: string[] = [];
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      if (wrapped) urls.push(await canvasToUrl(wrapped.canvas));
      else if (urls.length) urls.push(urls[urls.length - 1]);
    }
    return urls;
  } finally {
    input.dispose();
  }
}

export interface Waveform {
  /** Peak amplitude (0..1) per bucket. */
  peaks: Float32Array;
  peaksPerSecond: number;
}

export async function generateWaveform(file: File, asset: MediaAsset, peaksPerSecond = 50): Promise<Waveform | null> {
  if (!asset.hasAudio) return null;
  const input = openInput(file);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    const first = await track.getFirstTimestamp();
    const peaks = new Float32Array(Math.max(1, Math.ceil(asset.duration * peaksPerSecond)));
    const sink = new AudioBufferSink(track);
    for await (const { buffer, timestamp } of sink.buffers()) {
      const ch0 = buffer.getChannelData(0);
      const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
      const samplesPerPeak = buffer.sampleRate / peaksPerSecond;
      const baseIndex = (timestamp - first) * peaksPerSecond;
      for (let i = 0; i < ch0.length; i++) {
        const idx = Math.floor(baseIndex + i / samplesPerPeak);
        if (idx < 0 || idx >= peaks.length) continue;
        const v = Math.max(Math.abs(ch0[i]), Math.abs(ch1[i]));
        if (v > peaks[idx]) peaks[idx] = v;
      }
    }
    return { peaks, peaksPerSecond };
  } finally {
    input.dispose();
  }
}

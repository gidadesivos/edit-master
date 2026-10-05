/**
 * Runtime registry of imported media: maps asset ids to the actual File on the user's disk.
 * Nothing is uploaded anywhere — files are read locally on demand.
 */
import { create } from 'zustand';
import type { MediaAsset } from '../engine/types';
import type { FileHandleLike } from '../platform/fs';
import { forgetHandle, loadHandles, saveHandle } from './persist';
import { generateThumbnails, generateWaveform, probeFile, type Waveform } from './probe';

export type MediaStatus = 'ready' | 'missing';

interface Entry {
  file: File;
  url: string;
}

const entries = new Map<string, Entry>();

interface MediaState {
  status: Record<string, MediaStatus>;
  thumbs: Record<string, string[]>;
  waveforms: Record<string, Waveform>;
  /** Increments whenever a file is (re)attached, so the preview can refresh its elements. */
  revision: number;
}

export const useMedia = create<MediaState>(() => ({ status: {}, thumbs: {}, waveforms: {}, revision: 0 }));

export function getMediaUrl(assetId: string): string | null {
  return entries.get(assetId)?.url ?? null;
}

export function getMediaFile(assetId: string): File | null {
  return entries.get(assetId)?.file ?? null;
}

function attach(asset: MediaAsset, file: File): void {
  const prev = entries.get(asset.id);
  if (prev) URL.revokeObjectURL(prev.url);
  entries.set(asset.id, { file, url: URL.createObjectURL(file) });
  useMedia.setState((s) => ({ status: { ...s.status, [asset.id]: 'ready' }, revision: s.revision + 1 }));
  void buildPreviews(asset, file);
}

async function buildPreviews(asset: MediaAsset, file: File): Promise<void> {
  try {
    const count = asset.kind === 'video' ? Math.min(40, Math.max(4, Math.ceil(asset.duration / 2))) : 1;
    const thumbs = await generateThumbnails(file, asset, count);
    if (thumbs.length) useMedia.setState((s) => ({ thumbs: { ...s.thumbs, [asset.id]: thumbs } }));
  } catch (err) {
    console.warn('thumbnail failed', asset.name, err);
  }
  try {
    const wf = await generateWaveform(file, asset);
    if (wf) useMedia.setState((s) => ({ waveforms: { ...s.waveforms, [asset.id]: wf } }));
  } catch (err) {
    console.warn('waveform failed', asset.name, err);
  }
}

export interface ImportResult {
  assets: MediaAsset[];
  errors: string[];
}

export async function importFiles(files: Array<{ file: File; handle?: FileHandleLike }>): Promise<ImportResult> {
  const assets: MediaAsset[] = [];
  const errors: string[] = [];
  for (const { file, handle } of files) {
    try {
      const asset = await probeFile(file);
      attach(asset, file);
      if (handle) void saveHandle(asset.id, handle);
      assets.push(asset);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { assets, errors };
}

export function forgetMedia(assetId: string): void {
  const e = entries.get(assetId);
  if (e) URL.revokeObjectURL(e.url);
  entries.delete(assetId);
  void forgetHandle(assetId);
  useMedia.setState((s) => {
    const status = { ...s.status };
    delete status[assetId];
    return { status };
  });
}

/** Marks every asset of a freshly loaded project as missing, then tries to restore files from stored handles. */
export async function restoreMedia(assets: MediaAsset[], interactive = false): Promise<number> {
  const handles = await loadHandles();
  let missing = 0;
  for (const asset of assets) {
    if (entries.has(asset.id)) continue;
    const handle = handles[asset.id];
    let restored = false;
    if (handle) {
      try {
        let perm: PermissionState = (await handle.queryPermission?.({ mode: 'read' })) ?? 'granted';
        if (perm !== 'granted' && interactive) perm = (await handle.requestPermission?.({ mode: 'read' })) ?? 'denied';
        if (perm === 'granted') {
          const file = await handle.getFile();
          if (file.size === asset.size) {
            attach(asset, file);
            restored = true;
          }
        }
      } catch {
        // File moved or deleted — fall through to "missing".
      }
    }
    if (!restored) {
      missing++;
      useMedia.setState((s) => ({ status: { ...s.status, [asset.id]: 'missing' } }));
    }
  }
  return missing;
}

/** Re-attaches files the user picked to missing assets, matching by name and size. */
export function relinkFiles(assets: MediaAsset[], files: Array<{ file: File; handle?: FileHandleLike }>): number {
  let linked = 0;
  for (const asset of assets) {
    if (useMedia.getState().status[asset.id] === 'ready') continue;
    const match =
      files.find((f) => f.file.name === asset.name && f.file.size === asset.size) ??
      files.find((f) => f.file.size === asset.size && f.file.lastModified === asset.lastModified);
    if (match) {
      attach(asset, match.file);
      if (match.handle) void saveHandle(asset.id, match.handle);
      linked++;
    }
  }
  return linked;
}

export function clearAllMedia(): void {
  for (const e of entries.values()) URL.revokeObjectURL(e.url);
  entries.clear();
  useMedia.setState({ status: {}, thumbs: {}, waveforms: {}, revision: useMedia.getState().revision + 1 });
}

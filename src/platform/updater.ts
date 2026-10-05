/**
 * Auto-update for the Windows app. The app checks GitHub Releases (latest.json produced by the
 * release workflow), downloads the signed installer and restarts — no manual reinstall needed.
 * In the browser build this is a no-op: reloading the page already gives the newest version.
 */
import type { Update } from '@tauri-apps/plugin-updater';

declare const __APP_VERSION__: string;
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface AvailableUpdate {
  version: string;
  notes: string;
  raw: Update;
}

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!isDesktop) return null;
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();
  if (!update) return null;
  return { version: update.version, notes: update.body ?? '', raw: update };
}

export async function installUpdate(update: AvailableUpdate, onProgress: (fraction: number | null) => void): Promise<void> {
  let total = 0;
  let received = 0;
  await update.raw.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? 0;
      onProgress(total ? 0 : null);
    } else if (event.event === 'Progress') {
      received += event.data.chunkLength;
      onProgress(total ? received / total : null);
    } else if (event.event === 'Finished') {
      onProgress(1);
    }
  });
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

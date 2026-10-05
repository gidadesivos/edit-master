/** Local persistence in IndexedDB (stays on this computer, never synced anywhere). */
import { createStore, del, get, set } from 'idb-keyval';
import type { FileHandleLike } from '../platform/fs';

const store = createStore('edit-master', 'kv');
const AUTOSAVE_KEY = 'autosave:project';
const HANDLES_KEY = 'media:handles';

export async function saveAutosave(json: string): Promise<void> {
  await set(AUTOSAVE_KEY, { json, savedAt: Date.now() }, store);
}

export async function loadAutosave(): Promise<{ json: string; savedAt: number } | null> {
  try {
    return (await get(AUTOSAVE_KEY, store)) ?? null;
  } catch {
    return null;
  }
}

export async function clearAutosave(): Promise<void> {
  await del(AUTOSAVE_KEY, store);
}

export async function loadHandles(): Promise<Record<string, FileHandleLike>> {
  try {
    return (await get(HANDLES_KEY, store)) ?? {};
  } catch {
    return {};
  }
}

// Handle updates are read-modify-write, so they are serialized to avoid lost writes.
let queue: Promise<unknown> = Promise.resolve();
function serial(fn: () => Promise<void>): Promise<void> {
  const run = queue.then(fn, fn);
  queue = run.catch((err) => console.warn('could not persist file handle', err));
  return queue as Promise<void>;
}

export function saveHandle(assetId: string, handle: FileHandleLike): Promise<void> {
  return serial(async () => {
    const all = await loadHandles();
    all[assetId] = handle;
    await set(HANDLES_KEY, all, store);
  });
}

export function forgetHandle(assetId: string): Promise<void> {
  return serial(async () => {
    const all = await loadHandles();
    if (!(assetId in all)) return;
    delete all[assetId];
    await set(HANDLES_KEY, all, store);
  });
}

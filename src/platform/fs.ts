/**
 * File access helpers. Uses the File System Access API when available (Chrome, Edge and the
 * Windows app's WebView2) so media files can be re-opened after a restart without copying them,
 * and falls back to a classic <input type="file"> elsewhere.
 */

export interface FileHandleLike {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  queryPermission?(opts: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(opts: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface WritableLike {
  write(data: unknown): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

interface SaveHandleLike {
  name: string;
  createWritable(): Promise<WritableLike>;
}

interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}

type FsWindow = Window & {
  showOpenFilePicker?: (opts: { multiple?: boolean; types?: PickerType[]; excludeAcceptAllOption?: boolean }) => Promise<FileHandleLike[]>;
  showSaveFilePicker?: (opts: { suggestedName?: string; types?: PickerType[] }) => Promise<SaveHandleLike>;
};

const fsWindow = window as FsWindow;

export const MEDIA_ACCEPT = 'video/*,audio/*,image/*,.mkv,.mov,.m4a,.flac,.ogg,.opus';

const MEDIA_TYPES: PickerType[] = [
  {
    description: 'Vídeo, áudio e imagem',
    accept: {
      'video/*': ['.mp4', '.mov', '.webm', '.mkv', '.m4v'],
      'audio/*': ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac'],
      'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'],
    },
  },
];

export const supportsFileHandles = typeof fsWindow.showOpenFilePicker === 'function';

export interface PickedFile {
  file: File;
  handle?: FileHandleLike;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function pickWithInput(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const done = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => done([]));
    input.click();
  });
}

export async function pickMediaFiles(): Promise<PickedFile[]> {
  if (supportsFileHandles) {
    try {
      const handles = await fsWindow.showOpenFilePicker!({ multiple: true, types: MEDIA_TYPES });
      return Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle })));
    } catch (err) {
      if (isAbort(err)) return [];
      // Some embedders expose the API but block it; fall back to the input element.
    }
  }
  return (await pickWithInput(MEDIA_ACCEPT, true)).map((file) => ({ file }));
}

export async function pickProjectFile(): Promise<File | null> {
  if (supportsFileHandles) {
    try {
      const [handle] = await fsWindow.showOpenFilePicker!({
        multiple: false,
        types: [{ description: 'Projeto Edit Master', accept: { 'application/json': ['.emproj', '.json'] } }],
      });
      return handle ? handle.getFile() : null;
    } catch (err) {
      if (isAbort(err)) return null;
    }
  }
  const [file] = await pickWithInput('.emproj,.json,application/json', false);
  return file ?? null;
}

/** A writable destination: either a real file on disk or an in-memory buffer that gets downloaded. */
export interface SaveTarget {
  name: string;
  /** Writes using positioned chunks (needed for large MP4 exports). Null when only a final blob is supported. */
  writable: WritableLike | null;
}

export async function chooseSaveTarget(suggestedName: string, description: string, mime: string, ext: string): Promise<SaveTarget | null> {
  if (typeof fsWindow.showSaveFilePicker === 'function') {
    try {
      const handle = await fsWindow.showSaveFilePicker({
        suggestedName,
        types: [{ description, accept: { [mime]: [ext] } }],
      });
      return { name: handle.name, writable: await handle.createWritable() };
    } catch (err) {
      if (isAbort(err)) return null;
    }
  }
  return { name: suggestedName, writable: null };
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function saveTextFile(text: string, suggestedName: string, description: string, ext: string): Promise<boolean> {
  const target = await chooseSaveTarget(suggestedName, description, 'application/json', ext);
  if (!target) return false;
  if (target.writable) {
    await target.writable.write(text);
    await target.writable.close();
  } else {
    downloadBlob(new Blob([text], { type: 'application/json' }), suggestedName);
  }
  return true;
}

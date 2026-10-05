/** User-level commands shared by buttons, menus and keyboard shortcuts. */
import {
  addAsset,
  addClip,
  clipEnd,
  clipsAtTime,
  createProject,
  addTextClip,
  deleteClips,
  duplicateClip,
  extractAudio,
  removeAsset,
  rippleDelete,
  splitAt,
  updateClip,
} from '../engine/project';
import { PROJECT_FILE_EXTENSION, parseProject, serializeProject } from '../engine/serialize';
import { useEditor } from '../engine/store';
import { DEFAULT_TRANSFORM, type MediaAsset, type Project } from '../engine/types';
import { clearAllMedia, forgetMedia, importFiles, relinkFiles, restoreMedia, useMedia } from '../media/library';
import { saveAutosave } from '../media/persist';
import { pickMediaFiles, pickProjectFile, saveTextFile, type PickedFile } from '../platform/fs';
import { toast } from './toast';

const editor = () => useEditor.getState();

/** Picks a project resolution matching the first imported video (like CapCut's "Original" ratio). */
function adoptResolution(p: Project, asset: MediaAsset): Project {
  if (Object.keys(p.clips).length || asset.kind === 'audio' || !asset.width || !asset.height) return p;
  const scale = Math.min(1, 1080 / Math.min(asset.width, asset.height));
  const width = Math.max(2, Math.round((asset.width * scale) / 2) * 2);
  const height = Math.max(2, Math.round((asset.height * scale) / 2) * 2);
  return { ...p, settings: { ...p.settings, width, height } };
}

export async function importMedia(picked?: PickedFile[], place?: { trackId?: string; start?: number }): Promise<string[]> {
  const files = picked ?? (await pickMediaFiles());
  if (!files.length) return [];
  const busy = files.length > 1 ? `Importando ${files.length} arquivos…` : `Importando ${files[0].file.name}…`;
  toast(busy, 'info', undefined, 2500);
  const { assets, errors } = await importFiles(files);
  errors.forEach((e) => toast(e, 'error'));
  if (!assets.length) return [];

  const clipIds: string[] = [];
  editor().commit((p) => {
    const wasEmpty = Object.keys(p.assets).length === 0 && Object.keys(p.clips).length === 0;
    let next = p;
    for (const a of assets) next = addAsset(next, a);
    if (wasEmpty) next = adoptResolution(next, assets[0]);
    if (place) {
      let start = place.start;
      for (const a of assets) {
        const r = addClip(next, a.id, { trackId: place.trackId, start });
        next = r.project;
        clipIds.push(r.clipId);
        start = clipEnd(next.clips[r.clipId]);
      }
    }
    return next;
  });
  if (clipIds.length) editor().select(clipIds);
  toast(assets.length === 1 ? `"${assets[0].name}" importado` : `${assets.length} arquivos importados`, 'success');
  return assets.map((a) => a.id);
}

export function addAssetToTimeline(assetId: string, place: { trackId?: string; start?: number } = {}): void {
  let id = '';
  editor().commit((p) => {
    const r = addClip(p, assetId, place);
    id = r.clipId;
    return r.project;
  });
  if (id) editor().select([id]);
}

export function removeMediaAsset(assetId: string): void {
  const used = Object.values(editor().project.clips).some((c) => c.assetId === assetId);
  if (used && !confirm('Esta mídia está sendo usada na timeline. Remover a mídia e todos os seus clipes?')) return;
  editor().commit((p) => removeAsset(p, assetId));
  forgetMedia(assetId);
}

export function splitAtPlayhead(): void {
  const { playhead, selection, project } = editor();
  // Split the selected clips under the cursor; if none of them is under it, split everything there.
  const under = new Set(clipsAtTime(project, playhead).map((c) => c.id));
  const targets = selection.filter((id) => under.has(id));
  let created: string[] = [];
  editor().commit((p) => {
    const r = splitAt(p, playhead, targets.length ? targets : undefined);
    created = r.newClipIds;
    return r.project;
  });
  if (!created.length) toast('Posicione o cursor sobre um clipe para dividir.', 'info', undefined, 2500);
}

export function deleteSelection(ripple = false): void {
  const { selection } = editor();
  if (!selection.length) return;
  editor().commit((p) => (ripple ? rippleDelete(p, selection) : deleteClips(p, selection)));
  editor().select([]);
}

export function duplicateSelection(): void {
  const ids: string[] = [];
  editor().commit((p) => {
    let next = p;
    for (const id of editor().selection) {
      const r = duplicateClip(next, id);
      next = r.project;
      if (r.clipId) ids.push(r.clipId);
    }
    return next;
  });
  if (ids.length) editor().select(ids);
}

export function resetClipTransform(clipId: string): void {
  editor().commit((p) => updateClip(p, clipId, { transform: { ...DEFAULT_TRANSFORM }, opacity: 1, keyframes: {} }));
}

function safeFileName(name: string): string {
  return (name.trim() || 'projeto').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
}

export async function saveProjectFile(): Promise<void> {
  const p = editor().project;
  try {
    const ok = await saveTextFile(serializeProject(p), safeFileName(p.name) + PROJECT_FILE_EXTENSION, 'Projeto Edit Master', PROJECT_FILE_EXTENSION);
    if (ok) toast('Projeto salvo', 'success');
  } catch (err) {
    toast(`Não foi possível salvar: ${err instanceof Error ? err.message : err}`, 'error');
  }
}

function hasWork(): boolean {
  const p = editor().project;
  return Object.keys(p.clips).length > 0 || Object.keys(p.assets).length > 0;
}

export async function openProjectFile(): Promise<void> {
  if (hasWork() && !confirm('Abrir outro projeto? O projeto atual continua salvo apenas se você o salvou em arquivo.')) return;
  const file = await pickProjectFile();
  if (!file) return;
  try {
    const project = parseProject(await file.text());
    await loadAndRestore(project);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
  }
}

export async function loadAndRestore(project: Project): Promise<void> {
  clearAllMedia();
  editor().loadProject(project);
  const missing = await restoreMedia(Object.values(project.assets));
  if (missing > 0) {
    toast(`${missing} mídia(s) precisam ser reconectadas.`, 'info', { label: 'Reconectar', run: () => void relinkMissing() }, 0);
  }
}

export async function relinkMissing(): Promise<void> {
  const assets = Object.values(editor().project.assets);
  // First try stored file handles (asks for permission), then let the user pick the files.
  let missing = await restoreMedia(assets, true);
  if (!missing) {
    toast('Todas as mídias foram reconectadas', 'success');
    return;
  }
  const files = await pickMediaFiles();
  if (!files.length) return;
  relinkFiles(assets, files);
  missing = assets.filter((a) => useMedia.getState().status[a.id] !== 'ready').length;
  if (missing) toast(`${missing} mídia(s) ainda offline. Selecione os arquivos originais (mesmo nome e tamanho).`, 'error');
  else toast('Todas as mídias foram reconectadas', 'success');
}

export function newProject(): void {
  if (hasWork() && !confirm('Criar um novo projeto? Salve o atual em arquivo se quiser mantê-lo.')) return;
  clearAllMedia();
  const p = createProject();
  editor().loadProject(p);
  void saveAutosave(serializeProject(p));
}

export function togglePlay(): void {
  const s = editor();
  s.setPlaying(!s.playing);
}

export function stepFrames(n: number): void {
  const s = editor();
  s.setPlaying(false);
  const fps = s.project.settings.fps;
  s.setPlayhead(Math.round(s.playhead * fps + n) / fps);
}

export function addTextAtPlayhead(): void {
  const { playhead } = editor();
  let id = '';
  editor().commit((p) => {
    const r = addTextClip(p, playhead);
    id = r.clipId;
    return r.project;
  });
  if (id) editor().select([id]);
}

export function extractAudioFromClip(clipId: string): void {
  let id: string | null = null;
  editor().commit((p) => {
    const r = extractAudio(p, clipId);
    id = r.clipId;
    return r.project;
  });
  if (id) toast('Áudio separado para uma faixa de áudio', 'success');
}

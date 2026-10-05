import { Component, useEffect, useState, type ReactNode } from 'react';
import { projectDuration } from './engine/project';
import { parseProject, serializeProject } from './engine/serialize';
import { useEditor } from './engine/store';
import { loadAutosave, saveAutosave } from './media/persist';
import {
  deleteSelection,
  duplicateSelection,
  importMedia,
  loadAndRestore,
  openProjectFile,
  saveProjectFile,
  splitAtPlayhead,
  stepFrames,
  togglePlay,
} from './ui/actions';
import { ExportDialog } from './ui/ExportDialog';
import { Inspector } from './ui/Inspector';
import { MediaBin } from './ui/MediaBin';
import { PreviewPanel } from './ui/PreviewPanel';
import { Timeline } from './ui/Timeline';
import { Toasts } from './ui/Toasts';
import { TopBar } from './ui/TopBar';
import { UpdateBanner } from './ui/UpdateBanner';
import { toast } from './ui/toast';

const AUTOSAVE_DELAY = 800;

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLInputElement) return !['range', 'checkbox', 'radio', 'button', 'color'].includes(el.type);
  return el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

function useShortcuts(openExport: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const s = useEditor.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      let handled = true;
      if (mod && key === 'z' && !e.shiftKey) s.undo();
      else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) s.redo();
      else if (mod && key === 's') void saveProjectFile();
      else if (mod && key === 'o') void openProjectFile();
      else if (mod && key === 'e') openExport();
      else if (mod && key === 'i') void importMedia();
      else if (mod && key === 'd') duplicateSelection();
      else if (mod && key === 'a') s.select(Object.keys(s.project.clips));
      else if (mod && key === 'b') splitAtPlayhead();
      else if (mod) handled = false;
      else if (key === ' ' || e.code === 'Space') togglePlay();
      else if (key === 's') splitAtPlayhead();
      else if (key === 'delete' || key === 'backspace') deleteSelection(e.shiftKey);
      else if (key === 'arrowleft') stepFrames(e.shiftKey ? -s.project.settings.fps : -1);
      else if (key === 'arrowright') stepFrames(e.shiftKey ? s.project.settings.fps : 1);
      else if (key === 'home') s.setPlayhead(0);
      else if (key === 'end') s.setPlayhead(projectDuration(s.project));
      else if (key === '+' || key === '=') s.setZoom(s.zoom * 1.4);
      else if (key === '-') s.setZoom(s.zoom / 1.4);
      else if (key === 'n') s.setSnapping(!s.snapping);
      else if (key === 'escape') s.select([]);
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openExport]);
}

/** Restores the last session and keeps it autosaved locally. */
function useAutosave() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await loadAutosave();
      if (saved && !cancelled) {
        try {
          await loadAndRestore(parseProject(saved.json));
        } catch (err) {
          console.warn('autosave could not be restored', err);
          toast('O último projeto salvo automaticamente não pôde ser recuperado.', 'error');
        }
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      void saveAutosave(serializeProject(useEditor.getState().project)).catch((err) => console.warn('autosave failed', err));
    };
    const unsub = useEditor.subscribe((s, prev) => {
      if (s.project === prev.project || s.gestureBase) return;
      clearTimeout(timer);
      timer = setTimeout(flush, AUTOSAVE_DELAY);
    });
    const onHide = () => {
      if (timer) flush();
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      unsub();
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
      if (timer) flush();
    };
  }, [ready]);
  return ready;
}

/** Drop files anywhere in the window to import them. */
function useGlobalDrop() {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const overFn = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      depth = 0;
      setOver(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer!.files);
      if (files.length) void importMedia(files.map((file) => ({ file })));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overFn);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('drop', drop);
    };
  }, []);
  return over;
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(error);
    // Persist whatever we have so a reload recovers the work.
    void saveAutosave(serializeProject(useEditor.getState().project)).catch(() => undefined);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h1>Algo deu errado</h1>
        <p>Seu projeto foi salvo automaticamente. Recarregue para continuar de onde parou.</p>
        <pre>{this.state.error.message}</pre>
        <button className="primary" onClick={() => location.reload()}>
          Recarregar
        </button>
      </div>
    );
  }
}

export function App() {
  const [exporting, setExporting] = useState(false);
  const ready = useAutosave();
  const dragging = useGlobalDrop();
  useShortcuts(() => setExporting(true));

  if (!ready) return <div className="loading">Carregando…</div>;
  return (
    <ErrorBoundary>
      <div className="app">
        <TopBar onExport={() => setExporting(true)} />
        <UpdateBanner />
        <main className="workspace">
          <MediaBin />
          <PreviewPanel />
          <Inspector />
        </main>
        <Timeline />
        {exporting && <ExportDialog onClose={() => setExporting(false)} />}
        {dragging && <div className="drop-overlay">Solte para importar</div>}
        <Toasts />
      </div>
    </ErrorBoundary>
  );
}

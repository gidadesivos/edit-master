import { create } from 'zustand';
import { createProject, projectDuration } from './project';
import type { Project, Seconds } from './types';

const HISTORY_LIMIT = 200;

export interface EditorState {
  project: Project;
  past: Project[];
  future: Project[];
  /** Snapshot taken when a drag gesture starts; the whole gesture becomes one undo step. */
  gestureBase: Project | null;

  selection: string[];
  playhead: Seconds;
  playing: boolean;
  /** Pixels per second in the timeline. */
  zoom: number;
  snapping: boolean;

  /** Applies an edit as one undoable step. */
  commit: (edit: (p: Project) => Project) => void;
  beginGesture: () => void;
  /** Re-applies an edit on top of the gesture's starting snapshot (live preview while dragging). */
  gestureUpdate: (edit: (base: Project) => Project) => void;
  endGesture: () => void;
  cancelGesture: () => void;
  undo: () => void;
  redo: () => void;
  loadProject: (p: Project) => void;

  select: (ids: string[]) => void;
  setPlayhead: (t: Seconds) => void;
  setPlaying: (playing: boolean) => void;
  setZoom: (zoom: number) => void;
  setSnapping: (on: boolean) => void;
}

export const MIN_ZOOM = 2;
export const MAX_ZOOM = 600;

function pruneSelection(selection: string[], p: Project): string[] {
  const kept = selection.filter((id) => p.clips[id]);
  return kept.length === selection.length ? selection : kept;
}

export const useEditor = create<EditorState>((set, get) => ({
  project: createProject(),
  past: [],
  future: [],
  gestureBase: null,
  selection: [],
  playhead: 0,
  playing: false,
  zoom: 60,
  snapping: true,

  commit: (edit) => {
    const { project, past, gestureBase } = get();
    if (gestureBase) return; // edits are not allowed mid-gesture
    const next = edit(project);
    if (next === project) return;
    set({
      project: next,
      past: [...past, project].slice(-HISTORY_LIMIT),
      future: [],
      selection: pruneSelection(get().selection, next),
    });
  },

  beginGesture: () => {
    if (!get().gestureBase) set({ gestureBase: get().project });
  },

  gestureUpdate: (edit) => {
    const base = get().gestureBase;
    if (!base) return;
    set({ project: edit(base) });
  },

  endGesture: () => {
    const { gestureBase, project, past } = get();
    if (!gestureBase) return;
    if (project === gestureBase) {
      set({ gestureBase: null });
      return;
    }
    set({ gestureBase: null, past: [...past, gestureBase].slice(-HISTORY_LIMIT), future: [] });
  },

  cancelGesture: () => {
    const base = get().gestureBase;
    if (base) set({ project: base, gestureBase: null });
  },

  undo: () => {
    const { past, future, project, gestureBase } = get();
    if (gestureBase || !past.length) return;
    const prev = past[past.length - 1];
    set({
      project: prev,
      past: past.slice(0, -1),
      future: [project, ...future].slice(0, HISTORY_LIMIT),
      selection: pruneSelection(get().selection, prev),
    });
  },

  redo: () => {
    const { past, future, project, gestureBase } = get();
    if (gestureBase || !future.length) return;
    const next = future[0];
    set({
      project: next,
      past: [...past, project].slice(-HISTORY_LIMIT),
      future: future.slice(1),
      selection: pruneSelection(get().selection, next),
    });
  },

  loadProject: (p) =>
    set({ project: p, past: [], future: [], gestureBase: null, selection: [], playhead: 0, playing: false }),

  select: (ids) => set({ selection: ids }),
  setPlayhead: (t) => set({ playhead: Math.max(0, Math.min(t, Math.max(projectDuration(get().project), 0))) }),
  setPlaying: (playing) => set({ playing }),
  setZoom: (zoom) => set({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) }),
  setSnapping: (snapping) => set({ snapping }),
}));

import { create } from 'zustand';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
  action?: { label: string; run: () => void };
}

interface ToastState {
  toasts: Toast[];
}

export const useToasts = create<ToastState>(() => ({ toasts: [] }));
let nextId = 1;

export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action'], ms = kind === 'error' ? 8000 : 4000): void {
  const id = nextId++;
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, text, action }] }));
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: number): void {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

import { useEffect, useRef, useState } from 'react';
import { projectDuration } from '../engine/project';
import { useEditor } from '../engine/store';
import { formatDuration } from '../engine/time';
import { saveAutosave } from '../media/persist';
import { serializeProject } from '../engine/serialize';
import { chooseSaveTarget, downloadBlob } from '../platform/fs';
import { ExportCanceledError, exportProject, type ExportQuality } from '../render/export';
import { Icon } from './Icon';
import { toast } from './toast';

const RESOLUTIONS = [
  { label: '480p', short: 480 },
  { label: '720p', short: 720 },
  { label: '1080p (Full HD)', short: 1080 },
  { label: '1440p (2K)', short: 1440 },
  { label: '2160p (4K)', short: 2160 },
];

function dims(w: number, h: number, short: number) {
  const scale = short / Math.min(w, h);
  return { width: Math.round((w * scale) / 2) * 2, height: Math.round((h * scale) / 2) * 2 };
}

type Phase = { kind: 'setup' } | { kind: 'running'; progress: number; info: string; startedAt: number } | { kind: 'done'; seconds: number; name: string };

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project);
  const { width: pw, height: ph, fps: pfps } = project.settings;
  const projectShort = Math.min(pw, ph);
  const options = RESOLUTIONS.some((r) => r.short === projectShort)
    ? RESOLUTIONS
    : [...RESOLUTIONS, { label: 'Original do projeto', short: projectShort }].sort((a, b) => a.short - b.short);
  const [short, setShort] = useState(projectShort);
  const [fps, setFps] = useState(pfps);
  const [quality, setQuality] = useState<ExportQuality>('high');
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });
  const abortRef = useRef<AbortController | null>(null);
  const duration = projectDuration(project);
  const out = dims(pw, ph, short);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = async () => {
    const safe = (project.name.trim() || 'video').replace(/[\\/:*?"<>|]+/g, '_');
    const target = await chooseSaveTarget(`${safe}.mp4`, 'Vídeo MP4', 'video/mp4', '.mp4');
    if (!target) return;
    void saveAutosave(serializeProject(project));
    const abort = new AbortController();
    abortRef.current = abort;
    const startedAt = performance.now();
    setPhase({ kind: 'running', progress: 0, info: 'Preparando…', startedAt });
    useEditor.getState().setPlaying(false);
    try {
      const result = await exportProject(project, {
        ...out,
        fps,
        quality,
        target,
        signal: abort.signal,
        onProgress: (progress, info) => setPhase({ kind: 'running', progress, info, startedAt }),
      });
      if (result.blob) downloadBlob(result.blob, target.name);
      setPhase({ kind: 'done', seconds: (performance.now() - startedAt) / 1000, name: target.name });
    } catch (err) {
      if (err instanceof ExportCanceledError) {
        toast('Exportação cancelada');
        setPhase({ kind: 'setup' });
      } else {
        console.error(err);
        toast(`Falha na exportação: ${err instanceof Error ? err.message : String(err)}`, 'error');
        setPhase({ kind: 'setup' });
      }
    } finally {
      abortRef.current = null;
    }
  };

  const running = phase.kind === 'running';
  const eta =
    phase.kind === 'running' && phase.progress > 0.02
      ? ((performance.now() - phase.startedAt) / 1000) * ((1 - phase.progress) / phase.progress)
      : null;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <div className="modal-head">
          <h2 id="export-title">Exportar vídeo</h2>
          {!running && (
            <button className="icon" onClick={onClose} aria-label="Fechar">
              <Icon name="close" />
            </button>
          )}
        </div>

        {phase.kind === 'setup' && (
          <>
            <div className="modal-body">
              <label className="field">
                <span className="field-label">Resolução</span>
                <select value={short} onChange={(e) => setShort(Number(e.target.value))}>
                  {options.map((r) => {
                    const d = dims(pw, ph, r.short);
                    return (
                      <option key={r.short} value={r.short}>
                        {r.label} — {d.width}×{d.height}
                      </option>
                    );
                  })}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Quadros por segundo</span>
                <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                  {[24, 25, 30, 50, 60].map((f) => (
                    <option key={f} value={f}>
                      {f} fps
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Qualidade</span>
                <select value={quality} onChange={(e) => setQuality(e.target.value as ExportQuality)}>
                  <option value="medium">Média (arquivo menor)</option>
                  <option value="high">Alta (recomendado)</option>
                  <option value="very-high">Muito alta (arquivo maior)</option>
                </select>
              </label>
              <p className="muted">
                Formato MP4 · duração {formatDuration(duration)} · processado 100% no seu computador.
              </p>
            </div>
            <div className="modal-foot">
              <button className="ghost" onClick={onClose}>
                Cancelar
              </button>
              <button className="primary" disabled={duration <= 0} onClick={() => void start()}>
                <Icon name="export" /> Exportar
              </button>
            </div>
          </>
        )}

        {phase.kind === 'running' && (
          <>
            <div className="modal-body">
              <div className="progress" role="progressbar" aria-valuenow={Math.round(phase.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div style={{ width: `${phase.progress * 100}%` }} />
              </div>
              <p className="progress-info">
                <b>{Math.round(phase.progress * 100)}%</b> · {phase.info}
                {eta !== null && ` · faltam ~${formatDuration(eta)}`}
              </p>
              <p className="muted">Mantenha esta janela aberta. Você pode continuar olhando o projeto, mas não edite durante a exportação.</p>
            </div>
            <div className="modal-foot">
              <button className="ghost" onClick={() => abortRef.current?.abort()}>
                Cancelar exportação
              </button>
            </div>
          </>
        )}

        {phase.kind === 'done' && (
          <>
            <div className="modal-body">
              <p className="success-text">
                <Icon name="download" /> Vídeo exportado: <b>{phase.name}</b>
              </p>
              <p className="muted">Concluído em {formatDuration(phase.seconds)}.</p>
            </div>
            <div className="modal-foot">
              <button className="primary" onClick={onClose}>
                Fechar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

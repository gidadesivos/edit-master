import { useEffect, useRef, useState } from 'react';
import { CAPTION_LANGUAGES, CAPTION_MODELS, CaptionsCanceledError, timelineAudio16k, transcribe, type CaptionProgress } from '../ai/captions';
import { addCaptions } from '../engine/captions';
import { useEditor } from '../engine/store';
import { isAudibleClip } from '../render/compositor';
import { Icon } from './Icon';
import { toast } from './toast';

const STAGE_LABEL: Record<CaptionProgress['stage'], string> = {
  audio: 'Preparando o áudio…',
  download: 'Baixando o modelo de reconhecimento de fala (só na primeira vez)…',
  load: 'Carregando o modelo…',
  transcribe: 'Transcrevendo a fala…',
};

const MODEL_KEY = 'edit-master:caption-model';
const LANG_KEY = 'edit-master:caption-language';
const read = (k: string, fallback: string) => {
  try {
    return localStorage.getItem(k) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};

export function CaptionsDialog({ onClose }: { onClose: () => void }) {
  const hasAudio = useEditor((s) => Object.values(s.project.clips).some((c) => isAudibleClip(s.project, c)));
  const [model, setModel] = useState(() => read(MODEL_KEY, CAPTION_MODELS[1].id));
  const [language, setLanguage] = useState(() => read(LANG_KEY, 'portuguese'));
  const [progress, setProgress] = useState<CaptionProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const running = progress !== null;

  const start = async () => {
    write(MODEL_KEY, model);
    write(LANG_KEY, language);
    const abort = new AbortController();
    abortRef.current = abort;
    useEditor.getState().setPlaying(false);
    const project = useEditor.getState().project;
    try {
      setProgress({ stage: 'audio', progress: 0 });
      const audio = await timelineAudio16k(project, setProgress, abort.signal);
      const segments = await transcribe(audio, model, language === 'auto' ? null : language, setProgress, abort.signal);
      if (!segments.length) {
        toast('Nenhuma fala foi reconhecida no áudio.', 'info');
        setProgress(null);
        return;
      }
      let count = 0;
      useEditor.getState().commit((p) => {
        const r = addCaptions(p, segments);
        count = r.clipIds.length;
        return r.project;
      });
      toast(`${count} legendas criadas na faixa "Legendas". Clique numa legenda para editar o texto ou o estilo.`, 'success');
      onClose();
    } catch (err) {
      setProgress(null);
      if (err instanceof CaptionsCanceledError) return;
      console.error(err);
      const msg = err instanceof Error ? err.message : String(err);
      const network = /fetch|network|Failed to load|404|ENOTFOUND|NetworkError/i.test(msg);
      toast(
        network
          ? 'Não foi possível baixar o modelo de legendas. Na primeira vez é preciso estar conectado à internet; depois funciona offline.'
          : `Falha ao gerar legendas: ${msg}`,
        'error',
      );
    } finally {
      abortRef.current = null;
    }
  };

  const pct = progress?.progress != null ? Math.round(progress.progress * 100) : null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="captions-title">
        <div className="modal-head">
          <h2 id="captions-title">Legendas automáticas</h2>
          {!running && (
            <button className="icon" onClick={onClose} aria-label="Fechar">
              <Icon name="close" />
            </button>
          )}
        </div>
        {!running ? (
          <>
            <div className="modal-body">
              {!hasAudio && <p className="warning-text">A timeline não tem áudio. Adicione um vídeo com fala ou um áudio.</p>}
              <label className="field">
                <span className="field-label">Idioma da fala</span>
                <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {CAPTION_LANGUAGES.map((l) => (
                    <option key={l.label} value={l.code ?? 'auto'}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Qualidade</span>
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {CAPTION_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} (download {m.size})
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted small-text">
                A fala é reconhecida <b>no seu computador</b> com o modelo Whisper — nenhum áudio é enviado para a internet. O modelo é baixado
                uma única vez e fica guardado para as próximas vezes.
              </p>
            </div>
            <div className="modal-foot">
              <button className="ghost" onClick={onClose}>
                Cancelar
              </button>
              <button className="primary" disabled={!hasAudio} onClick={() => void start()}>
                <Icon name="captions" /> Gerar legendas
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="modal-body">
              <div className={`progress ${pct === null ? 'indeterminate' : ''}`} role="progressbar" aria-valuenow={pct ?? undefined}>
                <div style={{ width: pct === null ? '35%' : `${pct}%` }} />
              </div>
              <p className="progress-info">
                {STAGE_LABEL[progress.stage]} {pct !== null && <b>{pct}%</b>} {progress.detail && <span className="muted">· {progress.detail}</span>}
              </p>
            </div>
            <div className="modal-foot">
              <button className="ghost" onClick={() => abortRef.current?.abort()}>
                Cancelar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

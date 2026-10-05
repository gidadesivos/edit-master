import { clipDuration, updateClip } from '../engine/project';
import { useEditor } from '../engine/store';
import { formatDuration } from '../engine/time';
import type { Clip, Project, ProjectSettings } from '../engine/types';
import { resetClipTransform } from './actions';
import { Icon } from './Icon';

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  /** Builds the edited project from the gesture/commit base. */
  apply: (base: Project, v: number) => Project;
  defaultValue?: number;
}

/** A range input whose whole drag becomes a single undo step. */
function Slider({ label, value, min, max, step, format, apply, defaultValue }: SliderProps) {
  const s = useEditor.getState;
  const set = (v: number) => {
    if (s().gestureBase) s().gestureUpdate((base) => apply(base, v));
    else s().commit((p) => apply(p, v));
  };
  return (
    <label className="field slider">
      <span className="field-label">
        {label}
        <output>{format(value)}</output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={() => s().beginGesture()}
        onPointerUp={() => s().endGesture()}
        onPointerCancel={() => s().endGesture()}
        onBlur={() => s().endGesture()}
        onChange={(e) => set(Number(e.target.value))}
        onDoubleClick={() => defaultValue !== undefined && s().commit((p) => apply(p, defaultValue))}
        title="Duplo clique para restaurar o padrão"
      />
    </label>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function ClipInspector({ clip }: { clip: Clip }) {
  const asset = useEditor((s) => s.project.assets[clip.assetId]);
  const track = useEditor((s) => s.project.tracks.find((t) => t.id === clip.trackId));
  const id = clip.id;
  const dur = clipDuration(clip);
  const maxFade = Math.max(0, Math.min(10, dur / 2));
  const visual = track?.kind === 'video';

  const patchTransform = (key: keyof Clip['transform']) => (base: Project, v: number) => {
    const c = base.clips[id];
    return c ? updateClip(base, id, { transform: { ...c.transform, [key]: v } }) : base;
  };

  return (
    <>
      <div className="inspector-title">
        <Icon name={asset?.kind ?? 'video'} />
        <span title={asset?.name}>{asset?.name ?? 'Clipe'}</span>
        <small>{formatDuration(dur)}</small>
      </div>

      {visual && (
        <fieldset>
          <legend>Imagem</legend>
          <Slider label="Escala" value={clip.transform.scale} min={0.1} max={4} step={0.01} format={pct} apply={patchTransform('scale')} defaultValue={1} />
          <Slider label="Posição X" value={clip.transform.x} min={-1} max={1} step={0.005} format={pct} apply={patchTransform('x')} defaultValue={0} />
          <Slider label="Posição Y" value={clip.transform.y} min={-1} max={1} step={0.005} format={pct} apply={patchTransform('y')} defaultValue={0} />
          <Slider label="Rotação" value={clip.transform.rotation} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} apply={patchTransform('rotation')} defaultValue={0} />
          <Slider label="Opacidade" value={clip.opacity} min={0} max={1} step={0.01} format={pct} apply={(b, v) => updateClip(b, id, { opacity: v })} defaultValue={1} />
          <button className="ghost small" onClick={() => resetClipTransform(id)}>
            <Icon name="reset" /> Restaurar imagem
          </button>
        </fieldset>
      )}

      {asset?.hasAudio && (
        <fieldset>
          <legend>Áudio</legend>
          <Slider label="Volume" value={clip.volume} min={0} max={2} step={0.01} format={pct} apply={(b, v) => updateClip(b, id, { volume: v })} defaultValue={1} />
          <Slider label="Fade in" value={Math.min(clip.fadeIn, maxFade)} min={0} max={maxFade} step={0.05} format={(v) => `${v.toFixed(1)}s`} apply={(b, v) => updateClip(b, id, { fadeIn: v })} defaultValue={0} />
          <Slider label="Fade out" value={Math.min(clip.fadeOut, maxFade)} min={0} max={maxFade} step={0.05} format={(v) => `${v.toFixed(1)}s`} apply={(b, v) => updateClip(b, id, { fadeOut: v })} defaultValue={0} />
        </fieldset>
      )}
    </>
  );
}

const RATIOS: Array<{ label: string; w: number; h: number }> = [
  { label: '16:9 (YouTube)', w: 1920, h: 1080 },
  { label: '9:16 (TikTok/Reels)', w: 1080, h: 1920 },
  { label: '1:1 (Quadrado)', w: 1080, h: 1080 },
  { label: '4:5 (Instagram)', w: 1080, h: 1350 },
  { label: '4:3', w: 1440, h: 1080 },
  { label: '21:9 (Cinema)', w: 2560, h: 1080 },
];

function ProjectInspector() {
  const settings = useEditor((s) => s.project.settings);
  const commit = useEditor((s) => s.commit);
  const set = (patch: Partial<ProjectSettings>) => commit((p) => ({ ...p, settings: { ...p.settings, ...patch } }));
  const current = RATIOS.find((r) => r.w === settings.width && r.h === settings.height);

  return (
    <>
      <div className="inspector-title">
        <Icon name="video" />
        <span>Projeto</span>
      </div>
      <fieldset>
        <legend>Formato</legend>
        <label className="field">
          <span className="field-label">Proporção</span>
          <select
            value={current ? `${current.w}x${current.h}` : 'custom'}
            onChange={(e) => {
              const r = RATIOS.find((x) => `${x.w}x${x.h}` === e.target.value);
              if (r) set({ width: r.w, height: r.h });
            }}
          >
            {!current && <option value="custom">Original ({settings.width}×{settings.height})</option>}
            {RATIOS.map((r) => (
              <option key={r.label} value={`${r.w}x${r.h}`}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Quadros por segundo</span>
          <select value={settings.fps} onChange={(e) => set({ fps: Number(e.target.value) })}>
            {[24, 25, 30, 50, 60].map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </label>
        <label className="field row">
          <span className="field-label">Cor de fundo</span>
          <input type="color" value={settings.background} onChange={(e) => set({ background: e.target.value })} />
        </label>
      </fieldset>
      <div className="hint-box">
        <b>Dicas</b>
        <ul>
          <li>
            <kbd>Espaço</kbd> reproduzir / pausar
          </li>
          <li>
            <kbd>S</kbd> dividir no cursor
          </li>
          <li>
            <kbd>Del</kbd> apagar · <kbd>Shift</kbd>+<kbd>Del</kbd> apagar e fechar espaço
          </li>
          <li>
            <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicar · <kbd>Ctrl</kbd>+<kbd>Z</kbd> desfazer
          </li>
          <li>
            <kbd>←</kbd> <kbd>→</kbd> quadro a quadro · <kbd>Ctrl</kbd>+roda zoom
          </li>
        </ul>
      </div>
    </>
  );
}

export function Inspector() {
  const clip = useEditor((s) => (s.selection.length === 1 ? s.project.clips[s.selection[0]] : undefined));
  const count = useEditor((s) => s.selection.length);
  return (
    <section className="panel inspector" aria-label="Propriedades">
      <div className="panel-head">
        <h2>Propriedades</h2>
      </div>
      <div className="inspector-body">
        {clip ? <ClipInspector clip={clip} /> : count > 1 ? <p className="muted">{count} clipes selecionados</p> : <ProjectInspector />}
      </div>
    </section>
  );
}

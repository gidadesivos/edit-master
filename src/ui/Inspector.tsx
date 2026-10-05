import { useEffect, useState } from 'react';
import { hasKeyframes, keyframeAt, keyframeTimes, removeKeyframe, setProp, upsertKeyframe, valueAt } from '../engine/keyframes';
import {
  MAX_SPEED,
  MIN_SPEED,
  clipDuration,
  maxTransitionDuration,
  previousAdjacent,
  setClipSpeed,
  setTransition,
  updateClip,
  updateText,
} from '../engine/project';
import { useEditor } from '../engine/store';
import { formatDuration } from '../engine/time';
import {
  DEFAULT_ADJUSTMENTS,
  type Adjustments,
  type Clip,
  type FilterPreset,
  type KeyframeProp,
  type Project,
  type ProjectSettings,
  type TextAnimation,
  type TextStyle,
  type TransitionType,
} from '../engine/types';
import { useMedia } from '../media/library';
import { FILTER_PRESETS, FONTS, TEXT_ANIMATIONS, TRANSITIONS } from '../render/compositor';
import { extractAudioFromClip, resetClipTransform } from './actions';
import { Icon } from './Icon';

const s = useEditor.getState;

/** Applies an edit either as part of the running gesture (drag) or as its own undo step. */
function apply(edit: (base: Project) => Project) {
  if (s().gestureBase) s().gestureUpdate(edit);
  else s().commit(edit);
}

const gestureHandlers = {
  onPointerDown: () => s().beginGesture(),
  onPointerUp: () => s().endGesture(),
  onPointerCancel: () => s().endGesture(),
  onBlur: () => s().endGesture(),
};

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  apply: (base: Project, v: number) => Project;
  defaultValue?: number;
  /** Optional element shown next to the label (e.g. keyframe button). */
  extra?: React.ReactNode;
}

/** A range input whose whole drag becomes a single undo step. */
function Slider({ label, value, min, max, step, format, apply: applyValue, defaultValue, extra }: SliderProps) {
  return (
    <label className="field slider">
      <span className="field-label">
        <span className="label-text">
          {label}
          {extra}
        </span>
        <output>{format(value)}</output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        {...gestureHandlers}
        onChange={(e) => apply((b) => applyValue(b, Number(e.target.value)))}
        onDoubleClick={() => defaultValue !== undefined && s().commit((p) => applyValue(p, defaultValue))}
        title="Duplo clique para restaurar o padrão"
      />
    </label>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const signedPct = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;

function withClip(id: string, fn: (c: Clip) => Clip) {
  return (base: Project): Project => {
    const c = base.clips[id];
    return c ? { ...base, clips: { ...base.clips, [id]: fn(c) }, updatedAt: Date.now() } : base;
  };
}

// ---------------------------------------------------------------------------------------------

function useLocalTime(clip: Clip): { local: number; inside: boolean } {
  const playhead = useEditor((st) => st.playhead);
  const dur = clipDuration(clip);
  const raw = playhead - clip.start;
  return { local: Math.min(dur, Math.max(0, raw)), inside: raw >= -1e-6 && raw <= dur + 1e-6 };
}

function KeyframeButton({ clip, prop, local }: { clip: Clip; prop: KeyframeProp; local: number }) {
  const on = !!keyframeAt(clip, prop, local);
  const animated = hasKeyframes(clip, prop);
  return (
    <button
      type="button"
      className={`kf-btn ${on ? 'on' : animated ? 'animated' : ''}`}
      onClick={(e) => {
        e.preventDefault();
        s().commit(
          withClip(clip.id, (c) => (keyframeAt(c, prop, local) ? removeKeyframe(c, prop, local) : upsertKeyframe(c, prop, local, valueAt(c, prop, local)))),
        );
      }}
      title={on ? 'Remover keyframe neste ponto' : 'Adicionar keyframe no cursor'}
      aria-pressed={on}
    >
      ◆
    </button>
  );
}

function BasicTab({ clip }: { clip: Clip }) {
  const { local, inside } = useLocalTime(clip);
  const fps = useEditor((st) => st.project.settings.fps);
  const times = keyframeTimes(clip);
  const kfSlider = (prop: KeyframeProp, label: string, min: number, max: number, step: number, format: (v: number) => string, def: number) => (
    <Slider
      label={label}
      value={valueAt(clip, prop, local)}
      min={min}
      max={max}
      step={step}
      format={format}
      defaultValue={def}
      extra={<KeyframeButton clip={clip} prop={prop} local={local} />}
      apply={(b, v) => withClip(clip.id, (c) => setProp(c, prop, local, v))(b)}
    />
  );
  const jump = (dir: -1 | 1) => {
    const target = dir < 0 ? [...times].reverse().find((t) => t < local - 1e-3) : times.find((t) => t > local + 1e-3);
    if (target !== undefined) s().setPlayhead(Math.round((clip.start + target) * fps) / fps);
  };
  return (
    <>
      <fieldset>
        <legend>Posição e tamanho</legend>
        {kfSlider('scale', 'Escala', 0.1, 4, 0.01, pct, 1)}
        {kfSlider('x', 'Posição X', -1, 1, 0.005, pct, 0)}
        {kfSlider('y', 'Posição Y', -1, 1, 0.005, pct, 0)}
        {kfSlider('rotation', 'Rotação', -180, 180, 1, (v) => `${Math.round(v)}°`, 0)}
        {kfSlider('opacity', 'Opacidade', 0, 1, 0.01, pct, 1)}
        <div className="row-buttons">
          <button className="ghost small" onClick={() => jump(-1)} disabled={!times.some((t) => t < local - 1e-3)} title="Keyframe anterior">
            ◀ ◆
          </button>
          <button className="ghost small" onClick={() => jump(1)} disabled={!times.some((t) => t > local + 1e-3)} title="Próximo keyframe">
            ◆ ▶
          </button>
          <button className="ghost small" onClick={() => resetClipTransform(clip.id)}>
            <Icon name="reset" /> Restaurar
          </button>
        </div>
        <p className="muted small-text">
          {inside
            ? 'Clique em ◆ para criar um keyframe no cursor. Com keyframes, mudar um valor cria/atualiza o keyframe no ponto atual.'
            : 'Coloque o cursor sobre o clipe para animar com keyframes.'}
        </p>
      </fieldset>
    </>
  );
}

function FiltersTab({ clip }: { clip: Clip }) {
  const thumb = useMedia((st) => {
    const list = st.thumbs[clip.assetId];
    return list?.[Math.floor((list.length - 1) / 2)];
  });
  const adj = (key: keyof Adjustments, label: string, min: number, max: number, step: number, format: (v: number) => string) => (
    <Slider
      label={label}
      value={clip.adjust[key]}
      min={min}
      max={max}
      step={step}
      format={format}
      defaultValue={0}
      apply={(b, v) => withClip(clip.id, (c) => ({ ...c, adjust: { ...c.adjust, [key]: v } }))(b)}
    />
  );
  return (
    <>
      <fieldset>
        <legend>Filtros</legend>
        <div className="preset-grid">
          {(Object.keys(FILTER_PRESETS) as FilterPreset[]).map((f) => (
            <button
              key={f}
              className={`preset ${clip.filter === f ? 'active' : ''}`}
              onClick={() => s().commit((p) => updateClip(p, clip.id, { filter: f }))}
              aria-pressed={clip.filter === f}
            >
              <span className="preset-swatch" style={{ backgroundImage: thumb ? `url(${thumb})` : undefined, filter: FILTER_PRESETS[f].css || undefined }}>
                {FILTER_PRESETS[f].temperature !== 0 && (
                  <span className="tint" style={{ background: FILTER_PRESETS[f].temperature > 0 ? 'rgba(255,140,40,.25)' : 'rgba(40,140,255,.25)' }} />
                )}
              </span>
              {FILTER_PRESETS[f].label}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Ajustes</legend>
        {adj('brightness', 'Brilho', -1, 1, 0.01, signedPct)}
        {adj('contrast', 'Contraste', -1, 1, 0.01, signedPct)}
        {adj('saturation', 'Saturação', -1, 1, 0.01, signedPct)}
        {adj('temperature', 'Temperatura', -1, 1, 0.01, signedPct)}
        {adj('hue', 'Matiz', -180, 180, 1, (v) => `${Math.round(v)}°`)}
        {adj('blur', 'Desfoque', 0, 1, 0.01, pct)}
        {adj('vignette', 'Vinheta', 0, 1, 0.01, pct)}
        <button className="ghost small" onClick={() => s().commit((p) => updateClip(p, clip.id, { adjust: { ...DEFAULT_ADJUSTMENTS }, filter: 'none' }))}>
          <Icon name="reset" /> Restaurar cores
        </button>
      </fieldset>
    </>
  );
}

function TransitionTab({ clip }: { clip: Clip }) {
  const hasPrev = useEditor((st) => !!previousAdjacent(st.project, clip));
  const tr = clip.transitionIn;
  const max = maxTransitionDuration(clip);
  const choose = (type: TransitionType | null) =>
    s().commit((p) => setTransition(p, clip.id, type ? { type, duration: tr?.duration ?? Math.min(0.5, max) } : null));
  return (
    <fieldset>
      <legend>Transição de entrada</legend>
      <div className="preset-grid">
        <button className={`preset ${!tr ? 'active' : ''}`} onClick={() => choose(null)} aria-pressed={!tr}>
          <span className="preset-swatch icon-swatch">∅</span>
          Nenhuma
        </button>
        {(Object.keys(TRANSITIONS) as TransitionType[]).map((t) => (
          <button key={t} className={`preset ${tr?.type === t ? 'active' : ''}`} onClick={() => choose(t)} aria-pressed={tr?.type === t}>
            <span className={`preset-swatch tr-swatch tr-${t}`} />
            {TRANSITIONS[t]}
          </button>
        ))}
      </div>
      {tr && (
        <Slider
          label="Duração"
          value={tr.duration}
          min={0.1}
          max={max}
          step={0.05}
          format={(v) => `${v.toFixed(2)}s`}
          defaultValue={0.5}
          apply={(b, v) => setTransition(b, clip.id, { type: tr.type, duration: v })}
        />
      )}
      <p className="muted small-text">
        {hasPrev
          ? 'A transição acontece no início deste clipe, sobre o final do clipe anterior.'
          : 'Não há clipe colado antes deste na mesma faixa: a transição será feita a partir do fundo.'}
      </p>
    </fieldset>
  );
}

function SpeedTab({ clip }: { clip: Clip }) {
  const presets = [0.25, 0.5, 1, 1.5, 2, 3, 4];
  return (
    <fieldset>
      <legend>Velocidade</legend>
      <Slider
        label="Velocidade"
        value={Math.log2(clip.speed)}
        min={Math.log2(MIN_SPEED)}
        max={Math.log2(MAX_SPEED)}
        step={0.01}
        format={() => `${clip.speed.toFixed(2)}x`}
        defaultValue={0}
        apply={(b, v) => setClipSpeed(b, clip.id, Math.round(2 ** v * 100) / 100)}
      />
      <div className="chip-row">
        {presets.map((v) => (
          <button key={v} className={`chip ${Math.abs(clip.speed - v) < 1e-3 ? 'active' : ''}`} onClick={() => s().commit((p) => setClipSpeed(p, clip.id, v))}>
            {v}x
          </button>
        ))}
      </div>
      <p className="muted small-text">Duração no timeline: {formatDuration(clipDuration(clip))}. Os clipes seguintes da faixa se ajustam automaticamente.</p>
    </fieldset>
  );
}

function AudioTab({ clip, canExtract }: { clip: Clip; canExtract: boolean }) {
  const maxFade = Math.max(0, Math.min(10, clipDuration(clip) / 2));
  const set = (patch: Partial<Clip>) => (b: Project) => updateClip(b, clip.id, patch);
  return (
    <fieldset>
      <legend>Áudio</legend>
      <Slider label="Volume" value={clip.volume} min={0} max={2} step={0.01} format={pct} apply={(b, v) => set({ volume: v })(b)} defaultValue={1} />
      <Slider label="Fade in" value={Math.min(clip.fadeIn, maxFade)} min={0} max={maxFade} step={0.05} format={(v) => `${v.toFixed(1)}s`} apply={(b, v) => set({ fadeIn: v })(b)} defaultValue={0} />
      <Slider label="Fade out" value={Math.min(clip.fadeOut, maxFade)} min={0} max={maxFade} step={0.05} format={(v) => `${v.toFixed(1)}s`} apply={(b, v) => set({ fadeOut: v })(b)} defaultValue={0} />
      {canExtract && (
        <button className="ghost small" onClick={() => extractAudioFromClip(clip.id)} title="Copia o áudio para uma faixa de áudio e silencia o vídeo">
          <Icon name="audio" /> Separar áudio
        </button>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------------------------
// Text

const TEXT_PRESETS: Array<{ label: string; style: Partial<TextStyle> }> = [
  { label: 'Clássico', style: { color: '#ffffff', strokeWidth: 0.06, strokeColor: '#000000', background: '', shadow: true, font: 'Segoe UI', bold: true } },
  { label: 'Amarelo', style: { color: '#ffd60a', strokeWidth: 0.08, strokeColor: '#000000', background: '', shadow: true, font: 'Impact', bold: false } },
  { label: 'Legenda', style: { color: '#ffffff', strokeWidth: 0, background: '#000000', backgroundOpacity: 0.65, shadow: false, font: 'Segoe UI', bold: true } },
  { label: 'Etiqueta', style: { color: '#111111', strokeWidth: 0, background: '#ffffff', backgroundOpacity: 1, shadow: false, font: 'Arial', bold: true } },
  { label: 'Neon', style: { color: '#22d3ee', strokeWidth: 0.03, strokeColor: '#0e7490', background: '', shadow: true, font: 'Trebuchet MS', bold: true } },
  { label: 'Elegante', style: { color: '#f5f5f4', strokeWidth: 0, background: '', shadow: true, font: 'Georgia', bold: false, italic: true } },
];

function TextTab({ clip }: { clip: Clip }) {
  const st = clip.text!;
  const set = (patch: Partial<TextStyle>) => s().commit((p) => updateText(p, clip.id, patch));
  const [draft, setDraft] = useState(st.content);
  useEffect(() => setDraft(st.content), [clip.id, st.content]);
  return (
    <>
      <fieldset>
        <legend>Texto</legend>
        <textarea
          className="text-input"
          value={draft}
          rows={3}
          spellCheck
          onFocus={() => s().beginGesture()}
          onBlur={() => s().endGesture()}
          onChange={(e) => {
            const v = e.target.value;
            setDraft(v);
            apply((b) => updateText(b, clip.id, { content: v }));
          }}
          aria-label="Conteúdo do texto"
        />
        <div className="preset-grid text-presets">
          {TEXT_PRESETS.map((pr) => (
            <button key={pr.label} className="preset" onClick={() => set(pr.style)}>
              <span
                className="text-swatch"
                style={{
                  color: pr.style.color,
                  fontFamily: pr.style.font,
                  fontWeight: pr.style.bold ? 700 : 400,
                  fontStyle: pr.style.italic ? 'italic' : 'normal',
                  background: pr.style.background || 'transparent',
                  WebkitTextStroke: pr.style.strokeWidth ? `1px ${pr.style.strokeColor}` : undefined,
                }}
              >
                Aa
              </span>
              {pr.label}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Estilo</legend>
        <label className="field">
          <span className="field-label">Fonte</span>
          <select value={st.font} onChange={(e) => set({ font: e.target.value })}>
            {FONTS.map((f) => (
              <option key={f} value={f} style={{ fontFamily: f }}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <Slider label="Tamanho" value={st.size} min={0.02} max={0.3} step={0.002} format={(v) => `${Math.round(v * 1000) / 10}`} apply={(b, v) => updateText(b, clip.id, { size: v })} defaultValue={0.08} />
        <div className="row-buttons">
          <label className="color-field" title="Cor do texto">
            <input type="color" value={st.color} onChange={(e) => set({ color: e.target.value })} />
            Cor
          </label>
          <button className={`chip ${st.bold ? 'active' : ''}`} onClick={() => set({ bold: !st.bold })} aria-pressed={st.bold} title="Negrito">
            <b>B</b>
          </button>
          <button className={`chip ${st.italic ? 'active' : ''}`} onClick={() => set({ italic: !st.italic })} aria-pressed={st.italic} title="Itálico">
            <i>I</i>
          </button>
          {(['left', 'center', 'right'] as const).map((a) => (
            <button key={a} className={`chip ${st.align === a ? 'active' : ''}`} onClick={() => set({ align: a })} aria-pressed={st.align === a} title={`Alinhar ${a}`}>
              {a === 'left' ? '⇤' : a === 'center' ? '≡' : '⇥'}
            </button>
          ))}
        </div>
        <div className="row-buttons">
          <label className="color-field" title="Cor do contorno">
            <input type="color" value={st.strokeColor} onChange={(e) => set({ strokeColor: e.target.value })} />
            Contorno
          </label>
          <label className="check">
            <input type="checkbox" checked={st.shadow} onChange={(e) => set({ shadow: e.target.checked })} /> Sombra
          </label>
        </div>
        <Slider label="Espessura do contorno" value={st.strokeWidth} min={0} max={0.2} step={0.005} format={(v) => `${Math.round(v * 100)}`} apply={(b, v) => updateText(b, clip.id, { strokeWidth: v })} defaultValue={0.06} />
        <div className="row-buttons">
          <label className="check">
            <input type="checkbox" checked={!!st.background} onChange={(e) => set({ background: e.target.checked ? '#000000' : '' })} /> Fundo
          </label>
          {st.background && (
            <label className="color-field" title="Cor do fundo">
              <input type="color" value={st.background} onChange={(e) => set({ background: e.target.value })} />
              Cor do fundo
            </label>
          )}
        </div>
        {st.background && (
          <Slider label="Opacidade do fundo" value={st.backgroundOpacity} min={0} max={1} step={0.01} format={pct} apply={(b, v) => updateText(b, clip.id, { backgroundOpacity: v })} defaultValue={0.6} />
        )}
      </fieldset>
    </>
  );
}

function AnimationTab({ clip }: { clip: Clip }) {
  const st = clip.text!;
  const max = Math.max(0.1, Math.min(3, clipDuration(clip) / 2));
  const set = (patch: Partial<TextStyle>) => s().commit((p) => updateText(p, clip.id, patch));
  const select = (value: TextAnimation, on: (v: TextAnimation) => void) => (
    <select value={value} onChange={(e) => on(e.target.value as TextAnimation)}>
      {(Object.keys(TEXT_ANIMATIONS) as TextAnimation[]).map((a) => (
        <option key={a} value={a}>
          {TEXT_ANIMATIONS[a]}
        </option>
      ))}
    </select>
  );
  return (
    <>
      <fieldset>
        <legend>Entrada</legend>
        {select(st.animIn, (v) => set({ animIn: v }))}
        {st.animIn !== 'none' && (
          <Slider label="Duração" value={Math.min(st.animInDuration, max)} min={0.1} max={max} step={0.05} format={(v) => `${v.toFixed(2)}s`} apply={(b, v) => updateText(b, clip.id, { animInDuration: v })} defaultValue={0.4} />
        )}
      </fieldset>
      <fieldset>
        <legend>Saída</legend>
        {select(st.animOut, (v) => set({ animOut: v }))}
        {st.animOut !== 'none' && (
          <Slider label="Duração" value={Math.min(st.animOutDuration, max)} min={0.1} max={max} step={0.05} format={(v) => `${v.toFixed(2)}s`} apply={(b, v) => updateText(b, clip.id, { animOutDuration: v })} defaultValue={0.4} />
        )}
      </fieldset>
    </>
  );
}

// ---------------------------------------------------------------------------------------------

type TabId = 'text' | 'basic' | 'animation' | 'filters' | 'transition' | 'speed' | 'audio';
const TAB_LABELS: Record<TabId, string> = {
  text: 'Texto',
  basic: 'Básico',
  animation: 'Animação',
  filters: 'Filtros',
  transition: 'Transição',
  speed: 'Velocidade',
  audio: 'Áudio',
};

function ClipInspector({ clip }: { clip: Clip }) {
  const asset = useEditor((st) => st.project.assets[clip.assetId]);
  const track = useEditor((st) => st.project.tracks.find((t) => t.id === clip.trackId));
  const [tab, setTab] = useState<TabId>(() => (clip.kind === 'text' ? 'text' : 'basic'));
  const visual = track?.kind === 'video';
  const isText = clip.kind === 'text';

  const tabs: TabId[] = isText
    ? ['text', 'basic', 'animation', 'transition']
    : visual
      ? ['basic', 'filters', 'transition', ...(asset?.kind === 'video' ? (['speed'] as TabId[]) : []), ...(asset?.hasAudio ? (['audio'] as TabId[]) : [])]
      : ['audio', 'speed'];
  const current = tabs.includes(tab) ? tab : tabs[0];

  return (
    <>
      <div className="inspector-title">
        <Icon name={isText ? 'text' : (asset?.kind ?? 'video')} />
        <span title={isText ? clip.text?.content : asset?.name}>{isText ? clip.text?.content.split('\n')[0] || 'Texto' : (asset?.name ?? 'Clipe')}</span>
        <small>{formatDuration(clipDuration(clip))}</small>
      </div>
      <div className="tabs inspector-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t} role="tab" aria-selected={current === t} className={current === t ? 'active' : ''} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      {current === 'text' && <TextTab clip={clip} />}
      {current === 'basic' && <BasicTab clip={clip} />}
      {current === 'animation' && <AnimationTab clip={clip} />}
      {current === 'filters' && <FiltersTab clip={clip} />}
      {current === 'transition' && <TransitionTab clip={clip} />}
      {current === 'speed' && <SpeedTab clip={clip} />}
      {current === 'audio' && <AudioTab clip={clip} canExtract={visual && asset?.kind === 'video' && !!asset.hasAudio} />}
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
  const settings = useEditor((st) => st.project.settings);
  const commit = useEditor((st) => st.commit);
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
            {!current && (
              <option value="custom">
                Original ({settings.width}×{settings.height})
              </option>
            )}
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
            <kbd>S</kbd> dividir no cursor · <kbd>T</kbd> novo texto
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
  const clip = useEditor((st) => (st.selection.length === 1 ? st.project.clips[st.selection[0]] : undefined));
  const count = useEditor((st) => st.selection.length);
  return (
    <section className="panel inspector" aria-label="Propriedades">
      <div className="panel-head">
        <h2>Propriedades</h2>
      </div>
      <div className="inspector-body">
        {clip ? <ClipInspector key={clip.id} clip={clip} /> : count > 1 ? <p className="muted">{count} clipes selecionados</p> : <ProjectInspector />}
      </div>
    </section>
  );
}

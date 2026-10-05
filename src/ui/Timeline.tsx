import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  addTrack,
  clipDuration,
  clipEnd,
  moveClip,
  projectDuration,
  removeTrack,
  snap,
  snapPoints,
  snapRange,
  trimClip,
  updateTrack,
} from '../engine/project';
import { useEditor } from '../engine/store';
import { formatTime, rulerStep } from '../engine/time';
import type { Clip, MediaAsset, Track } from '../engine/types';
import { useMedia } from '../media/library';
import { addAssetToTimeline, deleteSelection, duplicateSelection, importMedia, splitAtPlayhead } from './actions';
import { Icon } from './Icon';
import { ASSET_DRAG_TYPE } from './MediaBin';

const HEADER_W = 148;
const RULER_H = 26;
const TRACK_H = { video: 64, audio: 48 } as const;
const EDGE_PX = 7;
const SNAP_PX = 8;

type DragMode = 'move' | 'trim-start' | 'trim-end';

/** Converts a client X coordinate into timeline seconds. */
function timeAtClientX(lanes: HTMLElement, clientX: number, zoom: number): number {
  const r = lanes.getBoundingClientRect();
  return Math.max(0, (clientX - r.left) / zoom);
}

function trackIdAtPoint(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-track-id]');
  return el?.dataset.trackId ?? null;
}

// ---------------------------------------------------------------------------------------------

const Filmstrip = memo(function Filmstrip({ clip, asset, width }: { clip: Clip; asset: MediaAsset; width: number }) {
  const thumbs = useMedia((s) => s.thumbs[asset.id]);
  if (!thumbs?.length) return null;
  if (asset.kind === 'image') {
    return <div className="filmstrip" style={{ backgroundImage: `url(${thumbs[0]})` }} />;
  }
  const aspect = asset.width && asset.height ? asset.width / asset.height : 16 / 9;
  const tileW = Math.max(40, (TRACK_H.video - 18) * aspect);
  const count = Math.min(120, Math.max(1, Math.ceil(width / tileW)));
  const w = width / count;
  const tiles = [];
  for (let i = 0; i < count; i++) {
    const src = clip.in + ((i + 0.5) * w * (clipDuration(clip) / width)) * clip.speed;
    const idx = Math.min(thumbs.length - 1, Math.max(0, Math.floor((src / Math.max(asset.duration, 1e-6)) * thumbs.length)));
    tiles.push(<img key={i} src={thumbs[idx]} style={{ width: w }} alt="" draggable={false} />);
  }
  return <div className="filmstrip">{tiles}</div>;
});

const Waveform = memo(function Waveform({ clip, asset, width, height }: { clip: Clip; asset: MediaAsset; width: number; height: number }) {
  const wf = useMedia((s) => s.waveforms[asset.id]);
  const ref = useRef<HTMLCanvasElement>(null);
  const pxW = Math.max(1, Math.min(4096, Math.round(width)));
  useEffect(() => {
    const c = ref.current;
    if (!c || !wf) return;
    c.width = pxW;
    c.height = height;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, pxW, height);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    const mid = height / 2;
    const span = clip.out - clip.in;
    for (let x = 0; x < pxW; x++) {
      const s0 = Math.floor((clip.in + (x / pxW) * span) * wf.peaksPerSecond);
      const s1 = Math.max(s0 + 1, Math.floor((clip.in + ((x + 1) / pxW) * span) * wf.peaksPerSecond));
      let peak = 0;
      for (let i = s0; i < s1 && i < wf.peaks.length; i++) peak = Math.max(peak, wf.peaks[i]);
      const h = Math.max(1, Math.min(1, peak * clip.volume) * (height - 4));
      ctx.fillRect(x, mid - h / 2, 1, h);
    }
  }, [wf, pxW, height, clip.in, clip.out, clip.volume]);
  if (!wf) return null;
  return <canvas ref={ref} className="waveform" style={{ width, height }} />;
});

interface ClipViewProps {
  clip: Clip;
  asset: MediaAsset | undefined;
  zoom: number;
  selected: boolean;
  offline: boolean;
  trackKind: Track['kind'];
  onPointerDown: (e: React.PointerEvent, clip: Clip, mode: DragMode) => void;
}

const ClipView = memo(function ClipView({ clip, asset, zoom, selected, offline, trackKind, onPointerDown }: ClipViewProps) {
  const left = clip.start * zoom;
  const width = Math.max(2, clipDuration(clip) * zoom);
  const h = TRACK_H[trackKind] - 8;
  const modeFor = (e: React.PointerEvent): DragMode => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - r.left;
    if (width > EDGE_PX * 3) {
      if (x <= EDGE_PX) return 'trim-start';
      if (x >= r.width - EDGE_PX) return 'trim-end';
    }
    return 'move';
  };
  return (
    <div
      className={`clip ${asset?.kind ?? ''} ${selected ? 'selected' : ''} ${offline ? 'offline' : ''}`}
      style={{ left, width, height: h }}
      onPointerDown={(e) => onPointerDown(e, clip, modeFor(e))}
      title={asset?.name}
    >
      {asset && trackKind === 'video' && <Filmstrip clip={clip} asset={asset} width={width} />}
      {asset?.hasAudio && trackKind === 'audio' && <Waveform clip={clip} asset={asset} width={width} height={h - 14} />}
      <span className="clip-label">
        {offline && <Icon name="warning" size={11} />} {asset?.name ?? 'mídia removida'}
      </span>
      {(clip.fadeIn > 0 || clip.fadeOut > 0) && (
        <svg className="fades" width={width} height={h} preserveAspectRatio="none">
          {clip.fadeIn > 0 && <polygon points={`0,0 ${clip.fadeIn * zoom},0 0,${h}`} />}
          {clip.fadeOut > 0 && <polygon points={`${width},0 ${width - clip.fadeOut * zoom},0 ${width},${h}`} />}
        </svg>
      )}
      <span className="handle start" />
      <span className="handle end" />
    </div>
  );
});

function Playhead({ zoom, height }: { zoom: number; height: number }) {
  const playhead = useEditor((s) => s.playhead);
  return (
    <div className="playhead" style={{ transform: `translateX(${playhead * zoom}px)`, height }}>
      <span className="playhead-cap" />
    </div>
  );
}

function Ruler({ zoom, width, fps }: { zoom: number; width: number; fps: number }) {
  const step = rulerStep(zoom);
  const marks = [];
  const count = Math.ceil(width / zoom / step) + 1;
  for (let i = 0; i < count; i++) {
    const t = i * step;
    marks.push(
      <span key={i} className="tick" style={{ left: t * zoom }}>
        {step < 1 ? formatTime(t, fps) : formatTime(t, fps).slice(0, -3)}
      </span>,
    );
  }
  return <div className="ruler-marks">{marks}</div>;
}

function TrackHeader({ track }: { track: Track }) {
  const commit = useEditor((s) => s.commit);
  const canRemove = useEditor((s) => s.project.tracks.filter((t) => t.kind === track.kind).length > 1);
  return (
    <div className={`track-header ${track.kind}`} style={{ height: TRACK_H[track.kind] }}>
      <Icon name={track.kind} size={14} />
      <span className="track-name">{track.name}</span>
      {track.kind === 'video' && (
        <button
          className="icon small"
          onClick={() => commit((p) => updateTrack(p, track.id, { hidden: !track.hidden }))}
          title={track.hidden ? 'Mostrar faixa' : 'Ocultar faixa'}
          aria-pressed={track.hidden}
        >
          <Icon name={track.hidden ? 'eyeOff' : 'eye'} size={14} />
        </button>
      )}
      <button
        className="icon small"
        onClick={() => commit((p) => updateTrack(p, track.id, { muted: !track.muted }))}
        title={track.muted ? 'Ativar som' : 'Silenciar faixa'}
        aria-pressed={track.muted}
      >
        <Icon name={track.muted ? 'mute' : 'volume'} size={14} />
      </button>
      {canRemove && (
        <button
          className="icon small"
          onClick={() => commit((p) => removeTrack(p, track.id))}
          title="Remover faixa (e seus clipes)"
          aria-label="Remover faixa"
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function Timeline() {
  const project = useEditor((s) => s.project);
  const zoom = useEditor((s) => s.zoom);
  const selection = useEditor((s) => s.selection);
  const snapping = useEditor((s) => s.snapping);
  const playing = useEditor((s) => s.playing);
  const status = useMedia((s) => s.status);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(1000);
  const [dropHint, setDropHint] = useState<number | null>(null);
  const selected = useMemo(() => new Set(selection), [selection]);

  const duration = projectDuration(project);
  const contentW = Math.max(viewW - HEADER_W, (duration + 30) * zoom);
  const tracksH = project.tracks.reduce((h, t) => h + TRACK_H[t.kind], 0);

  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Follow the playhead while playing.
  useEffect(() => {
    if (!playing) return;
    return useEditor.subscribe((s) => {
      const el = scrollRef.current;
      if (!el) return;
      const x = s.playhead * s.zoom;
      const visible = el.clientWidth - HEADER_W;
      if (x < el.scrollLeft || x > el.scrollLeft + visible - 40) el.scrollLeft = Math.max(0, x - visible * 0.1);
    });
  }, [playing]);

  // Ctrl/⌘ + wheel zooms around the cursor (native listener so we can preventDefault).
  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const s = useEditor.getState();
      const r = lanesRef.current!.getBoundingClientRect();
      const t = (e.clientX - r.left) / s.zoom; // time under the cursor stays fixed
      s.setZoom(s.zoom * Math.exp(-e.deltaY * 0.0015));
      const z = useEditor.getState().zoom;
      const elLeft = el.getBoundingClientRect().left;
      requestAnimationFrame(() => {
        el.scrollLeft = Math.max(0, elLeft + HEADER_W + t * z - e.clientX);
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ---- scrubbing ----
  const startScrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const s = useEditor.getState();
    s.setPlaying(false);
    const lanes = lanesRef.current!;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const seek = (clientX: number) => {
      let t = timeAtClientX(lanes, clientX, useEditor.getState().zoom);
      if (useEditor.getState().snapping) {
        t = snap(t, snapPoints(useEditor.getState().project, new Set()), SNAP_PX / useEditor.getState().zoom);
      }
      useEditor.getState().setPlayhead(t);
    };
    seek(e.clientX);
    const move = (ev: PointerEvent) => seek(ev.clientX);
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  // ---- clip drag / trim ----
  const onClipPointerDown = (e: React.PointerEvent, clip: Clip, mode: DragMode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const s = useEditor.getState();
    s.setPlaying(false);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (additive) {
      s.select(selected.has(clip.id) ? selection.filter((id) => id !== clip.id) : [...selection, clip.id]);
      return;
    }
    if (!selected.has(clip.id) || selection.length > 1) s.select([clip.id]);

    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;
    const ignore = new Set([clip.id]);

    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return;
        started = true;
        useEditor.getState().beginGesture();
      }
      const st = useEditor.getState();
      const base = st.gestureBase!;
      const z = st.zoom;
      const dt = (ev.clientX - startX) / z;
      const points = st.snapping ? snapPoints(base, ignore, [st.playhead]) : [];
      const thr = SNAP_PX / z;
      const original = base.clips[clip.id];
      if (!original) return;
      if (mode === 'move') {
        let start = Math.max(0, original.start + dt);
        if (st.snapping) start = snapRange(start, clipDuration(original), points, thr);
        let trackId = original.trackId;
        const over = trackIdAtPoint(ev.clientX, ev.clientY);
        const overTrack = base.tracks.find((t) => t.id === over);
        const ownTrack = base.tracks.find((t) => t.id === original.trackId);
        if (overTrack && ownTrack && overTrack.kind === ownTrack.kind) trackId = overTrack.id;
        st.gestureUpdate((b) => moveClip(b, clip.id, trackId, start));
      } else {
        const edgeT = mode === 'trim-start' ? original.start : clipEnd(original);
        let t = edgeT + dt;
        if (st.snapping) t = snap(t, points, thr);
        st.gestureUpdate((b) => trimClip(b, clip.id, mode === 'trim-start' ? 'start' : 'end', t));
      }
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', cancel);
      if (started) useEditor.getState().endGesture();
    };
    const cancel = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', cancel);
      if (started) useEditor.getState().cancelGesture();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', cancel);
  };

  // ---- drops from the media bin / file system ----
  const onDragOver = (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types);
    if (!types.includes(ASSET_DRAG_TYPE) && !types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDropHint(timeAtClientX(lanesRef.current!, e.clientX, zoom));
  };
  const onDrop = (e: React.DragEvent) => {
    setDropHint(null);
    const assetId = e.dataTransfer.getData(ASSET_DRAG_TYPE);
    const files = Array.from(e.dataTransfer.files);
    if (!assetId && !files.length) return;
    e.preventDefault();
    e.stopPropagation();
    const st = useEditor.getState();
    let start = timeAtClientX(lanesRef.current!, e.clientX, zoom);
    if (st.snapping) start = snap(start, snapPoints(st.project, new Set(), [st.playhead]), SNAP_PX / zoom);
    const trackId = trackIdAtPoint(e.clientX, e.clientY) ?? undefined;
    if (assetId) addAssetToTimeline(assetId, { trackId, start });
    else void importMedia(files.map((file) => ({ file })), { trackId, start });
  };

  const sel = selection.length;
  return (
    <section className="panel timeline" aria-label="Timeline">
      <div className="timeline-toolbar">
        <button className="icon" onClick={splitAtPlayhead} title="Dividir no cursor (S)" aria-label="Dividir">
          <Icon name="split" />
        </button>
        <button className="icon" disabled={!sel} onClick={() => deleteSelection(false)} title="Apagar (Del)" aria-label="Apagar">
          <Icon name="trash" />
        </button>
        <button className="icon" disabled={!sel} onClick={duplicateSelection} title="Duplicar (Ctrl+D)" aria-label="Duplicar">
          <Icon name="copy" />
        </button>
        <span className="sep" />
        <button
          className={`icon ${snapping ? 'on' : ''}`}
          onClick={() => useEditor.getState().setSnapping(!snapping)}
          title="Ímã: encaixar nas bordas (N)"
          aria-pressed={snapping}
        >
          <Icon name="magnet" />
        </button>
        <button className="ghost small" onClick={() => useEditor.getState().commit((p) => addTrack(p, 'video').project)}>
          <Icon name="plus" /> Faixa de vídeo
        </button>
        <button className="ghost small" onClick={() => useEditor.getState().commit((p) => addTrack(p, 'audio').project)}>
          <Icon name="plus" /> Faixa de áudio
        </button>
        <span className="spacer" />
        <button className="icon" onClick={() => useEditor.getState().setZoom(zoom / 1.4)} title="Diminuir zoom (-)" aria-label="Diminuir zoom">
          <Icon name="zoomOut" />
        </button>
        <input
          className="zoom-slider"
          type="range"
          min={Math.log(2)}
          max={Math.log(600)}
          step={0.01}
          value={Math.log(zoom)}
          onChange={(e) => useEditor.getState().setZoom(Math.exp(Number(e.target.value)))}
          aria-label="Zoom da timeline"
        />
        <button className="icon" onClick={() => useEditor.getState().setZoom(zoom * 1.4)} title="Aumentar zoom (+)" aria-label="Aumentar zoom">
          <Icon name="zoomIn" />
        </button>
        <button
          className="ghost small"
          onClick={() => {
            const el = scrollRef.current!;
            const d = Math.max(duration, 5);
            useEditor.getState().setZoom((el.clientWidth - HEADER_W - 40) / d);
            el.scrollLeft = 0;
          }}
          title="Ajustar à janela"
        >
          Ajustar
        </button>
      </div>

      <div className="timeline-scroll" ref={scrollRef} onDragOver={onDragOver} onDragLeave={() => setDropHint(null)} onDrop={onDrop}>
        <div className="timeline-grid" style={{ width: HEADER_W + contentW }}>
          <div className="ruler-row" style={{ height: RULER_H }}>
            <div className="corner" style={{ width: HEADER_W }} />
            <div className="ruler" style={{ width: contentW }} onPointerDown={startScrub}>
              <Ruler zoom={zoom} width={contentW} fps={project.settings.fps} />
            </div>
          </div>
          <div className="tracks-row">
            <div className="headers" style={{ width: HEADER_W }}>
              {project.tracks.map((t) => (
                <TrackHeader key={t.id} track={t} />
              ))}
            </div>
            <div
              className="lanes"
              ref={lanesRef}
              style={{ width: contentW, height: tracksH }}
              onPointerDown={(e) => {
                if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('lane')) {
                  useEditor.getState().select([]);
                  startScrub(e);
                }
              }}
            >
              {project.tracks.map((t) => (
                <div
                  key={t.id}
                  className={`lane ${t.kind} ${t.hidden ? 'hidden-track' : ''} ${t.muted ? 'muted-track' : ''}`}
                  data-track-id={t.id}
                  style={{ height: TRACK_H[t.kind] }}
                >
                  {Object.values(project.clips)
                    .filter((c) => c.trackId === t.id)
                    .map((c) => (
                      <ClipView
                        key={c.id}
                        clip={c}
                        asset={project.assets[c.assetId]}
                        zoom={zoom}
                        selected={selected.has(c.id)}
                        offline={status[c.assetId] !== 'ready'}
                        trackKind={t.kind}
                        onPointerDown={onClipPointerDown}
                      />
                    ))}
                </div>
              ))}
              {dropHint !== null && <div className="drop-hint" style={{ left: dropHint * zoom }} />}
              <Playhead zoom={zoom} height={tracksH} />
            </div>
          </div>
          {Object.keys(project.clips).length === 0 && (
            <div className="timeline-empty" style={{ left: HEADER_W }}>
              Arraste mídias aqui para começar a editar
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

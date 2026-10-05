import { useEffect, useRef } from 'react';
import { projectDuration } from '../engine/project';
import { useEditor } from '../engine/store';
import { formatTime } from '../engine/time';
import { PreviewEngine } from '../render/preview';
import { stepFrames, togglePlay } from './actions';
import { Icon } from './Icon';

function TimeReadout() {
  const playhead = useEditor((s) => s.playhead);
  const fps = useEditor((s) => s.project.settings.fps);
  const duration = useEditor((s) => projectDuration(s.project));
  return (
    <span className="timecode">
      <b>{formatTime(playhead, fps)}</b> / {formatTime(duration, fps)}
    </span>
  );
}

export function PreviewPanel() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const { width, height } = useEditor((s) => s.project.settings);
  const playing = useEditor((s) => s.playing);
  const empty = useEditor((s) => Object.keys(s.project.clips).length === 0);

  useEffect(() => {
    const engine = new PreviewEngine(canvasRef.current!);
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // Fit the canvas into the stage while keeping the project aspect ratio.
  useEffect(() => {
    const stage = stageRef.current!;
    const canvas = canvasRef.current!;
    const fit = () => {
      const r = stage.getBoundingClientRect();
      const scale = Math.min(r.width / width, r.height / height);
      const cssW = Math.max(1, Math.floor(width * scale));
      const cssH = Math.max(1, Math.floor(height * scale));
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      const dpr = window.devicePixelRatio || 1;
      // Render at display resolution (never above the project resolution) to keep playback smooth.
      const pxScale = Math.min(1, (cssW * dpr) / width);
      const w = Math.max(2, Math.round(width * pxScale));
      const h = Math.max(2, Math.round(height * pxScale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      engineRef.current?.invalidate();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [width, height]);

  return (
    <section className="panel preview" aria-label="Pré-visualização">
      <div className="stage" ref={stageRef} onDoubleClick={() => stageRef.current?.requestFullscreen?.()}>
        <canvas ref={canvasRef} />
        {empty && <div className="stage-hint">Adicione mídias à timeline para começar</div>}
      </div>
      <div className="transport">
        <TimeReadout />
        <div className="transport-buttons">
          <button className="icon" onClick={() => useEditor.getState().setPlayhead(0)} title="Início (Home)" aria-label="Ir para o início">
            <Icon name="prev" />
          </button>
          <button className="icon" onClick={() => stepFrames(-1)} title="Quadro anterior (←)" aria-label="Quadro anterior">
            ‹
          </button>
          <button className="play" onClick={togglePlay} title="Reproduzir/Pausar (Espaço)" aria-label={playing ? 'Pausar' : 'Reproduzir'}>
            <Icon name={playing ? 'pause' : 'play'} size={20} />
          </button>
          <button className="icon" onClick={() => stepFrames(1)} title="Próximo quadro (→)" aria-label="Próximo quadro">
            ›
          </button>
          <button
            className="icon"
            onClick={() => {
              const s = useEditor.getState();
              s.setPlayhead(projectDuration(s.project));
            }}
            title="Fim (End)"
            aria-label="Ir para o fim"
          >
            <Icon name="next" />
          </button>
        </div>
        <span className="resolution">
          {width}×{height}
          <button className="icon small" onClick={() => stageRef.current?.requestFullscreen?.()} title="Tela cheia" aria-label="Tela cheia">
            <Icon name="fullscreen" />
          </button>
        </span>
      </div>
    </section>
  );
}

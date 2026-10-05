import { useState } from 'react';
import { useEditor } from '../engine/store';
import { formatDuration } from '../engine/time';
import type { MediaAsset } from '../engine/types';
import { useMedia } from '../media/library';
import { addAssetToTimeline, importMedia, relinkMissing, removeMediaAsset } from './actions';
import { Icon } from './Icon';

export const ASSET_DRAG_TYPE = 'application/x-edit-master-asset';

export function MediaBin() {
  const assets = useEditor((s) => s.project.assets);
  const status = useMedia((s) => s.status);
  const thumbs = useMedia((s) => s.thumbs);
  const [filter, setFilter] = useState<'all' | MediaAsset['kind']>('all');

  const list = Object.values(assets)
    .filter((a) => filter === 'all' || a.kind === filter)
    .sort((a, b) => a.name.localeCompare(b.name));
  const missing = Object.values(assets).filter((a) => status[a.id] !== 'ready').length;

  return (
    <section className="panel media-bin" aria-label="Mídia">
      <div className="panel-head">
        <h2>Mídia</h2>
        <button className="primary small" onClick={() => void importMedia()} title="Importar arquivos (Ctrl+I)">
          <Icon name="import" /> Importar
        </button>
      </div>
      <div className="tabs" role="tablist">
        {(['all', 'video', 'audio', 'image'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
            {{ all: 'Tudo', video: 'Vídeo', audio: 'Áudio', image: 'Imagem' }[k]}
          </button>
        ))}
      </div>
      {missing > 0 && (
        <button className="warning-bar" onClick={() => void relinkMissing()}>
          <Icon name="link" /> {missing} mídia(s) offline — clique para reconectar
        </button>
      )}
      {list.length === 0 ? (
        <div className="empty-bin" onClick={() => void importMedia()}>
          <Icon name="import" size={32} />
          <p>Arraste vídeos, áudios e imagens para cá</p>
          <small>ou clique para escolher arquivos. Nada é enviado para a internet.</small>
        </div>
      ) : (
        <ul className="asset-grid">
          {list.map((a) => {
            const thumb = thumbs[a.id]?.[Math.floor((thumbs[a.id].length - 1) / 2)];
            const offline = status[a.id] !== 'ready';
            return (
              <li
                key={a.id}
                className={`asset ${offline ? 'offline' : ''}`}
                draggable={!offline}
                onDragStart={(e) => {
                  e.dataTransfer.setData(ASSET_DRAG_TYPE, a.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onDoubleClick={() => !offline && addAssetToTimeline(a.id)}
                title={`${a.name}\n${a.width ? `${a.width}×${a.height} · ` : ''}${a.kind === 'image' ? 'imagem' : formatDuration(a.duration)}\nDuplo clique ou arraste para a timeline`}
              >
                <div className="asset-thumb">
                  {thumb ? <img src={thumb} alt="" draggable={false} /> : <Icon name={a.kind} size={28} />}
                  {a.kind !== 'image' && <span className="badge">{formatDuration(a.duration)}</span>}
                  {offline && (
                    <span className="badge warn">
                      <Icon name="warning" size={12} /> offline
                    </span>
                  )}
                  <div className="asset-actions">
                    <button
                      className="icon small"
                      disabled={offline}
                      onClick={() => addAssetToTimeline(a.id)}
                      title="Adicionar ao fim da timeline"
                      aria-label="Adicionar à timeline"
                    >
                      <Icon name="plus" />
                    </button>
                    <button className="icon small" onClick={() => removeMediaAsset(a.id)} title="Remover mídia" aria-label="Remover mídia">
                      <Icon name="trash" />
                    </button>
                  </div>
                </div>
                <span className="asset-name">{a.name}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

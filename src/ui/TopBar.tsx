import { useEditor } from '../engine/store';
import { APP_VERSION } from '../platform/updater';
import { newProject, openProjectFile, saveProjectFile } from './actions';
import { Icon } from './Icon';
import { VersionButton } from './UpdateBanner';

export function TopBar({ onExport }: { onExport: () => void }) {
  const name = useEditor((s) => s.project.name);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const commit = useEditor((s) => s.commit);

  return (
    <header className="topbar">
      <div className="brand">
        <img src="./icon.svg" alt="" width={22} height={22} />
        <span>Edit Master</span>
        <VersionButton version={APP_VERSION} />
      </div>
      <div className="topbar-group">
        <button className="ghost" onClick={newProject} title="Novo projeto">
          <Icon name="file" /> Novo
        </button>
        <button className="ghost" onClick={() => void openProjectFile()} title="Abrir projeto (Ctrl+O)">
          <Icon name="folder" /> Abrir
        </button>
        <button className="ghost" onClick={() => void saveProjectFile()} title="Salvar projeto em arquivo (Ctrl+S)">
          <Icon name="save" /> Salvar
        </button>
        <span className="sep" />
        <button className="icon" disabled={!canUndo} onClick={undo} title="Desfazer (Ctrl+Z)" aria-label="Desfazer">
          <Icon name="undo" />
        </button>
        <button className="icon" disabled={!canRedo} onClick={redo} title="Refazer (Ctrl+Shift+Z)" aria-label="Refazer">
          <Icon name="redo" />
        </button>
      </div>
      <input
        key={name}
        className="project-name"
        defaultValue={name}
        aria-label="Nome do projeto"
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            e.currentTarget.value = name;
            e.currentTarget.blur();
          }
        }}
        onBlur={(e) => {
          const v = e.target.value.trim() || 'Projeto sem título';
          if (v !== name) commit((p) => ({ ...p, name: v }));
          else e.target.value = name;
        }}
      />
      <div className="topbar-group right">
        <button className="primary" onClick={onExport} title="Exportar vídeo (Ctrl+E)">
          <Icon name="export" /> Exportar
        </button>
      </div>
    </header>
  );
}

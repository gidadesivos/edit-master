import { useEffect, useState } from 'react';
import { serializeProject } from '../engine/serialize';
import { useEditor } from '../engine/store';
import { saveAutosave } from '../media/persist';
import { checkForUpdate, installUpdate, isDesktop, type AvailableUpdate } from '../platform/updater';
import { Icon } from './Icon';
import { toast } from './toast';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** Shows a banner when a new version is published on GitHub Releases (Windows app only). */
export function UpdateBanner() {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [progress, setProgress] = useState<number | null | undefined>(undefined);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isDesktop) return;
    let alive = true;
    const run = () =>
      checkForUpdate()
        .then((u) => alive && u && setUpdate(u))
        .catch((err) => console.warn('update check failed', err));
    const first = setTimeout(run, 3000);
    const timer = setInterval(run, CHECK_EVERY_MS);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  if (!update || dismissed) return null;
  const installing = progress !== undefined;

  const install = async () => {
    useEditor.getState().setPlaying(false);
    // Make sure the current work is safe before the app restarts.
    await saveAutosave(serializeProject(useEditor.getState().project));
    setProgress(null);
    try {
      await installUpdate(update, setProgress);
    } catch (err) {
      setProgress(undefined);
      toast(`Não foi possível atualizar: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  return (
    <div className="update-banner" role="status">
      <Icon name="download" />
      <span>
        Nova versão <b>{update.version}</b> disponível.
        {installing && (progress === null ? ' Baixando…' : ` Baixando… ${Math.round((progress ?? 0) * 100)}%`)}
      </span>
      {!installing && (
        <>
          <button className="primary small" onClick={() => void install()}>
            Atualizar e reiniciar
          </button>
          <button className="ghost small" onClick={() => setDismissed(true)}>
            Depois
          </button>
        </>
      )}
    </div>
  );
}

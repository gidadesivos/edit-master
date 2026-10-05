import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { serializeProject } from '../engine/serialize';
import { useEditor } from '../engine/store';
import { saveAutosave } from '../media/persist';
import { checkForUpdate, installUpdate, isDesktop, type AvailableUpdate } from '../platform/updater';
import { Icon } from './Icon';
import { toast } from './toast';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

interface UpdateState {
  update: AvailableUpdate | null;
  checking: boolean;
  dismissed: boolean;
}

const useUpdate = create<UpdateState>(() => ({ update: null, checking: false, dismissed: false }));

/** Checks GitHub Releases. When `manual`, the result (including errors) is reported to the user. */
export async function checkUpdatesNow(manual = false): Promise<void> {
  if (!isDesktop) {
    if (manual) toast('A versão no navegador já é sempre a mais recente — basta recarregar a página.', 'info');
    return;
  }
  if (useUpdate.getState().checking) return;
  useUpdate.setState({ checking: true });
  try {
    const update = await checkForUpdate();
    useUpdate.setState({ update, dismissed: false });
    if (manual && !update) toast('Você já está usando a versão mais recente.', 'success');
  } catch (err) {
    console.warn('update check failed', err);
    if (manual) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(`Não foi possível verificar atualizações: ${msg}. Verifique sua conexão com a internet.`, 'error');
    }
  } finally {
    useUpdate.setState({ checking: false });
  }
}

/** Shows a banner when a new version is published on GitHub Releases (Windows app only). */
export function UpdateBanner() {
  const { update, dismissed } = useUpdate();
  const [progress, setProgress] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    if (!isDesktop) return;
    const first = setTimeout(() => void checkUpdatesNow(false), 3000);
    const timer = setInterval(() => void checkUpdatesNow(false), CHECK_EVERY_MS);
    return () => {
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
          <button className="ghost small" onClick={() => useUpdate.setState({ dismissed: true })}>
            Depois
          </button>
        </>
      )}
    </div>
  );
}

/** Version label in the top bar; clicking it checks for updates. */
export function VersionButton({ version }: { version: string }) {
  const checking = useUpdate((s) => s.checking);
  return (
    <button className="version-btn" onClick={() => void checkUpdatesNow(true)} title="Verificar atualizações" disabled={checking}>
      v{version}
      <Icon name="refresh" size={12} />
    </button>
  );
}

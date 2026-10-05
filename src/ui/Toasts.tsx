import { dismissToast, useToasts } from './toast';
import { Icon } from './Icon';

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.text}</span>
          {t.action && (
            <button
              className="ghost small"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon small" onClick={() => dismissToast(t.id)} aria-label="Fechar">
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

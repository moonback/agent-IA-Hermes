import { useEffect } from 'react';
import { Bell, X } from 'lucide-react';
import { useApp, type AppNotification } from '../../store';
import { cx } from '../ui';

const TONE: Record<AppNotification['level'], string> = {
  info: 'ring-info-fg/30',
  success: 'ring-success-fg/30',
  warn: 'ring-warning-fg/40',
  error: 'ring-danger-fg/40',
};

/** In-app toasts for server notices (proactive missions); the Windows toast is shown by the server. */
export function Notifications() {
  const items = useApp((s) => s.notifications);
  const dismiss = useApp((s) => s.dismissNotification);
  const navigate = useApp((s) => s.navigate);
  useEffect(() => {
    if (!items.length) return;
    const oldest = items[0]!;
    const t = window.setTimeout(() => dismiss(oldest.id), oldest.level === 'error' ? 15_000 : 8_000);
    return () => window.clearTimeout(t);
  }, [items, dismiss]);
  if (!items.length) return null;
  return (
    <div
      className="fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      aria-live="polite"
    >
      {items.map((n) => (
        <div
          key={n.id}
          role={n.level === 'error' ? 'alert' : 'status'}
          className={cx('glass appear rounded-panel p-3 text-sm ring-1 ring-inset', TONE[n.level])}
        >
          <div className="flex items-start gap-2">
            <Bell className="mt-0.5 size-4 shrink-0 text-accent-fg" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{n.title}</p>
              {n.body && <p className="text-xs text-muted">{n.body}</p>}
              {n.missionId && (
                <button
                  type="button"
                  className="mt-1 text-xs text-accent-fg hover:underline"
                  onClick={() => {
                    navigate('missions', n.missionId);
                    dismiss(n.id);
                  }}
                >
                  Voir la mission
                </button>
              )}
            </div>
            <button
              type="button"
              aria-label="Fermer la notification"
              className="press rounded-control p-0.5 text-muted hover:text-fg"
              onClick={() => dismiss(n.id)}
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

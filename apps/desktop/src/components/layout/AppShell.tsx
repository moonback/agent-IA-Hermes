import { useEffect, useRef, type ReactNode } from 'react';
import { api } from '../../api';
import { useAction, useMediaQuery, useResource } from '../../hooks';
import { usePrefs } from '../../prefs';
import { useApp } from '../../store';
import type { Status } from '../../types';
import { ErrorBox } from '../ui';
import { ActivityPanel } from './ActivityPanel';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

/** Global frame: sidebar, top bar, emergency banner, scrollable content and the activity panel. */
export function AppShell({ children }: { children: ReactNode }) {
  const page = useApp((s) => s.page);
  const { sidebarCollapsed, toggleSidebar, activityPanel, toggleActivityPanel } = usePrefs();
  const narrow = useMediaQuery('(max-width: 1099px)');
  const wide = useMediaQuery('(min-width: 90rem)');
  const status = useResource<Status>('/api/status', { intervalMs: 15_000 });
  const stop = useAction(() => api('/api/emergency-stop', { body: {} }), status.reload);
  const rearm = useAction(() => api('/api/rearm', { body: {} }), status.reload);
  const halted = status.data?.halted ?? false;
  const main = useRef<HTMLElement>(null);

  // Each page starts at the top, as with a real navigation.
  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [page]);

  return (
    <div className="relative flex h-full">
      <div className="app-backdrop" aria-hidden />
      <a
        href="#main"
        className="sr-only z-50 rounded-control bg-solid px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Aller au contenu
      </a>
      <Sidebar
        collapsed={narrow || sidebarCollapsed}
        canCollapse={!narrow}
        onToggle={toggleSidebar}
        version={status.data?.version}
      />
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <Topbar
          halted={halted}
          onStop={() => void stop.run()}
          onRearm={() => void rearm.run()}
          stopping={stop.pending}
          rearming={rearm.pending}
          activity={wide ? { open: activityPanel, toggle: toggleActivityPanel } : null}
        />
        {halted && (
          <p
            role="alert"
            className="shrink-0 bg-danger-soft px-5 py-2 text-sm font-medium text-danger-fg ring-1 ring-current/25"
          >
            Arrêt d’urgence actif : aucune action ne peut être exécutée.
          </p>
        )}
        <div className="flex min-h-0 flex-1">
          <main
            id="main"
            ref={main}
            tabIndex={-1}
            className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-4 outline-none sm:p-6"
          >
            <div className="mx-auto max-w-[110rem] space-y-0">
              {status.error && status.error.code === 'UNREACHABLE' && (
                <div className="mb-4">
                  <ErrorBox error={status.error.message} title="Service local indisponible" />
                </div>
              )}
              {(stop.error ?? rearm.error) && (
                <div className="mb-4">
                  <ErrorBox error={stop.error ?? rearm.error} />
                </div>
              )}
              {children}
            </div>
          </main>
          {wide && activityPanel && <ActivityPanel status={status.data} />}
        </div>
      </div>
    </div>
  );
}

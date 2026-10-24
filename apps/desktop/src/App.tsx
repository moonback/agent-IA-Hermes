import { useEffect } from 'react';
import {
  Bot,
  Brain,
  History,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  Monitor,
  Moon,
  OctagonX,
  ShieldCheck,
  Sun,
  Wrench,
} from 'lucide-react';
import { api } from './api';
import { useAction, useResource } from './hooks';
import { useApp, type Page } from './store';
import type { Status } from './types';
import { Button, ErrorBox, cx } from './components/ui';
import { DashboardPage } from './pages/Dashboard';
import { ChatPage } from './pages/Chat';
import { MissionsPage } from './pages/Missions';
import { ComputerPage } from './pages/Computer';
import { AgentsPage } from './pages/Agents';
import { ModelsPage } from './pages/Models';
import { ToolsPage } from './pages/Tools';
import { HistoryPage } from './pages/History';

const NAV: { id: Page; label: string; icon: typeof Bot }[] = [
  { id: 'dashboard', label: 'Tableau de bord', icon: LayoutDashboard },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'missions', label: 'Missions', icon: ListChecks },
  { id: 'computer', label: 'Ordinateur', icon: Monitor },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'models', label: 'Modèles et OpenRouter', icon: Brain },
  { id: 'tools', label: 'Outils et permissions', icon: ShieldCheck },
  { id: 'history', label: 'Historique et mémoire', icon: History },
];

const PAGES: Record<Page, () => React.JSX.Element> = {
  dashboard: DashboardPage,
  chat: ChatPage,
  missions: MissionsPage,
  computer: ComputerPage,
  agents: AgentsPage,
  models: ModelsPage,
  tools: ToolsPage,
  history: HistoryPage,
};

export function App() {
  const { page, navigate, theme, toggleTheme, connected, start } = useApp();
  useEffect(() => start(), [start]);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);
  const status = useResource<Status>('/api/status', { intervalMs: 15_000 });
  const stop = useAction(() => api('/api/emergency-stop', { body: {} }), status.reload);
  const rearm = useAction(() => api('/api/rearm', { body: {} }), status.reload);
  const Current = PAGES[page];
  const halted = status.data?.halted ?? false;

  return (
    <div className="flex h-full">
      <nav
        aria-label="Navigation principale"
        className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex items-center gap-2 px-4 py-4">
          <Wrench className="size-5 text-accent-500" aria-hidden />
          <span className="font-semibold tracking-wide">HERMES</span>
          <span className="ml-auto text-xs text-slate-500">{status.data?.version ?? ''}</span>
        </div>
        <ul className="flex-1 space-y-0.5 px-2">
          {NAV.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <button
                type="button"
                aria-current={page === id ? 'page' : undefined}
                onClick={() => navigate(id)}
                className={cx(
                  'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors',
                  page === id
                    ? 'bg-accent-600/15 font-medium text-accent-600 dark:text-accent-400'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                )}
              >
                <Icon className="size-4" aria-hidden /> {label}
              </button>
            </li>
          ))}
        </ul>
        <div className="space-y-2 border-t border-slate-200 p-3 dark:border-slate-800">
          <p className="flex items-center gap-2 text-xs text-slate-500" role="status">
            <span
              className={cx('size-2 rounded-full', connected ? 'bg-emerald-500' : 'bg-red-500')}
              aria-hidden
            />
            {connected ? 'Service local connecté' : 'Service local déconnecté'}
          </p>
          <Button
            variant="ghost"
            className="w-full"
            icon={theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            onClick={toggleTheme}
          >
            Thème {theme === 'dark' ? 'clair' : 'sombre'}
          </Button>
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-5 py-2.5 dark:border-slate-800 dark:bg-slate-900">
          {halted ? (
            <>
              <p className="text-sm font-medium text-red-600 dark:text-red-400" role="alert">
                Arrêt d’urgence actif : aucune action ne peut être exécutée.
              </p>
              <Button className="ml-auto" pending={rearm.pending} onClick={() => void rearm.run()}>
                Réarmer HERMES
              </Button>
            </>
          ) : (
            <Button
              variant="danger"
              className="ml-auto"
              icon={<OctagonX className="size-4" />}
              pending={stop.pending}
              onClick={() => void stop.run()}
              title="Bloque toute nouvelle action, annule les tâches et arrête les processus"
            >
              Arrêt d’urgence
            </Button>
          )}
        </header>
        <main className="flex-1 overflow-y-auto p-5">
          {status.error && status.error.code === 'UNREACHABLE' && (
            <ErrorBox error={status.error.message} title="Service local indisponible" />
          )}
          <ErrorBox error={stop.error ?? rearm.error} />
          <Current />
        </main>
      </div>
    </div>
  );
}

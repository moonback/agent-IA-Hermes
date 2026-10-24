import { OctagonX, PanelRight, Settings } from 'lucide-react';
import { useApp } from '../../store';
import { Button, cx } from '../ui';
import { NAV_SECTIONS, navItem } from './nav';

export function Topbar({
  halted,
  onStop,
  onRearm,
  stopping,
  rearming,
  activity,
}: {
  halted: boolean;
  onStop: () => void;
  onRearm: () => void;
  stopping: boolean;
  rearming: boolean;
  /** Present only when the window is wide enough for the activity panel. */
  activity: { open: boolean; toggle: () => void } | null;
}) {
  const page = useApp((s) => s.page);
  const connected = useApp((s) => s.connected);
  const navigate = useApp((s) => s.navigate);
  const current = navItem(page);
  const section = NAV_SECTIONS.find((s) => s.items.some((i) => i.id === page))?.title;
  const Icon = current.icon;

  return (
    <header className="glass relative z-10 flex h-(--topbar-height) shrink-0 items-center gap-3 rounded-none border-x-0 border-t-0 px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <Icon className="size-4.5 shrink-0 text-accent-fg" aria-hidden />
        <p className="min-w-0 truncate text-sm">
          {section && <span className="text-faint">{section} / </span>}
          <span className="font-medium">{current.label}</span>
        </p>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {/* Real SSE connection state to the local service, not an assumption. */}
        <p
          role="status"
          className={cx(
            'hidden items-center gap-2 rounded-full px-2.5 py-1 text-xs ring-1 ring-inset sm:flex',
            connected
              ? 'bg-success-soft text-success-fg ring-current/20'
              : 'bg-danger-soft text-danger-fg ring-current/25',
          )}
        >
          {connected ? (
            <span className="live-dot size-1.5" aria-hidden />
          ) : (
            <span className="size-1.5 rounded-full bg-current" aria-hidden />
          )}
          {connected ? 'Service local connecté' : 'Service local déconnecté'}
        </p>
        {activity && (
          <Button
            variant="ghost"
            aria-label="Panneau d’activité"
            aria-pressed={activity.open}
            title={activity.open ? 'Masquer le panneau d’activité' : 'Afficher le panneau d’activité'}
            icon={<PanelRight className="size-4" />}
            onClick={activity.toggle}
            className={activity.open ? 'text-accent-fg' : undefined}
          />
        )}
        <Button
          variant="ghost"
          aria-label="Ouvrir les paramètres"
          title="Paramètres"
          icon={<Settings className="size-4" />}
          onClick={() => navigate('settings')}
        />
        {halted ? (
          <Button variant="primary" pending={rearming} onClick={onRearm}>
            Réarmer HERMES
          </Button>
        ) : (
          <Button
            variant="danger"
            icon={<OctagonX className="size-4" />}
            pending={stopping}
            onClick={onStop}
            title="Bloque toute nouvelle action, annule les tâches et arrête les processus"
          >
            Arrêt d’urgence
          </Button>
        )}
      </div>
    </header>
  );
}

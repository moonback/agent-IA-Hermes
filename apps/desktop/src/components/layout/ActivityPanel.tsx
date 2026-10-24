import { missionTitle } from '../../labels';
import { Activity, ShieldAlert } from 'lucide-react';
import { useApp } from '../../store';
import type { Status } from '../../types';
import { EventList } from '../shared';
import { Badge, StatusBadge, cx } from '../ui';

const fmtUptime = (sec: number) =>
  sec < 3600
    ? `${Math.max(1, Math.round(sec / 60))} min`
    : `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;

/**
 * Right-hand overview fed only by data the shell already has: the polled /api/status and the
 * events received live over SSE since the connection opened. It issues no request of its own.
 */
export function ActivityPanel({ status }: { status: Status | null }) {
  const events = useApp((s) => s.events);
  const connected = useApp((s) => s.connected);
  const navigate = useApp((s) => s.navigate);
  const recent = events.slice(-15);

  return (
    <aside
      aria-label="Activité"
      className="glass flex w-80 shrink-0 flex-col gap-4 overflow-y-auto rounded-none border-y-0 border-r-0 p-4"
    >
      <section>
        <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wider text-faint uppercase">
          <Activity className="size-3.5" aria-hidden /> Service
        </h2>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Flux temps réel</dt>
            <dd>
              <Badge tone={connected ? 'success' : 'danger'}>{connected ? 'en ligne' : 'hors ligne'}</Badge>
            </dd>
          </div>
          {status && (
            <>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Exécution</dt>
                <dd>
                  <Badge tone={status.halted ? 'danger' : 'success'}>
                    {status.halted ? 'bloquée' : 'autorisée'}
                  </Badge>
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Actif depuis</dt>
                <dd className="tabular-nums">{fmtUptime(status.uptimeSec)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Boucles d’agents</dt>
                <dd className="tabular-nums">{status.workers.activeLoops}</dd>
              </div>
            </>
          )}
        </dl>
      </section>

      {status && (
        <section>
          <h2 className="mb-2 text-xs font-semibold tracking-wider text-faint uppercase">
            Missions actives ({status.missions.active.length})
          </h2>
          {status.missions.active.length === 0 ? (
            <p className="text-sm text-muted">Aucune mission en cours.</p>
          ) : (
            <ul className="space-y-1.5">
              {status.missions.active.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => navigate('missions', m.id)}
                    className={cx(
                      'card-hover flex w-full flex-col gap-1 rounded-control bg-raised p-2 text-left text-sm ring-1 ring-line ring-inset',
                      m.status === 'running' && 'is-live',
                    )}
                  >
                    <StatusBadge status={m.status} />
                    <span className="line-clamp-2 break-words">{missionTitle(m.request)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {status.missions.pendingApprovals > 0 && (
            <button
              type="button"
              onClick={() => navigate('dashboard')}
              className="press mt-2 flex w-full items-center gap-2 rounded-control bg-warning-soft px-2 py-1.5 text-left text-sm text-warning-fg ring-1 ring-current/25 ring-inset"
            >
              <ShieldAlert className="size-4" aria-hidden />
              {status.missions.pendingApprovals} décision(s) en attente
            </button>
          )}
        </section>
      )}

      <section className="min-h-0">
        <h2 className="mb-1 text-xs font-semibold tracking-wider text-faint uppercase">
          Événements en direct
        </h2>
        <EventList
          events={recent}
          compact
          live={false}
          empty="Aucun événement reçu depuis l’ouverture de la session."
        />
      </section>
    </aside>
  );
}

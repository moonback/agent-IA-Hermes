import { useMemo, useState } from 'react';
import { Download, Pause, Play, RotateCcw, Square, Trash2 } from 'lucide-react';
import { api, downloadFile } from '../api';
import { useAction, useResource } from '../hooks';
import { useApp } from '../store';
import type { MissionDetail, MissionEvent } from '../types';
import { ApprovalCard, EventList, PlanView } from './shared';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Json,
  Loading,
  ProgressBar,
  StatusBadge,
  fmtDate,
  fmtDuration,
  fmtUsd,
} from './ui';

/** Full, live view of one mission: controls, plan, tasks with evidence, approvals, stream and events. */
export function MissionView({ missionId }: { missionId: string }) {
  const detail = useResource<MissionDetail>(`/api/missions/${missionId}`);
  const events = useResource<MissionEvent[]>(`/api/events?missionId=${missionId}&limit=300`);
  const stream = useApp((s) => s.streams[missionId]);
  const [confirm, setConfirm] = useState<string[]>([]);
  const reload = () => {
    detail.reload();
    events.reload();
  };
  const start = useAction(
    () => api(`/api/missions/${missionId}/start`, { body: { confirmUncertainTaskIds: confirm } }),
    reload,
  );
  const pause = useAction(() => api(`/api/missions/${missionId}/pause`, { body: {} }), reload);
  const cancel = useAction(() => api(`/api/missions/${missionId}/cancel`, { body: {} }), reload);
  const exportReport = useAction(() =>
    downloadFile(`/api/missions/${missionId}/report`, `hermes-${missionId}.md`),
  );
  const { navigate } = useApp();
  const deleteMission = useAction(
    () => api(`/api/missions/${missionId}`, { method: 'DELETE' }),
    () => navigate('missions', null),
  );

  const callsByTask = useMemo(() => {
    const m = new Map<string, MissionDetail['toolCalls']>();
    for (const c of detail.data?.toolCalls ?? [])
      m.set(c.taskId ?? '', [...(m.get(c.taskId ?? '') ?? []), c]);
    return m;
  }, [detail.data]);

  if (detail.loading && !detail.data) return <Loading />;
  if (detail.error) return <ErrorBox error={detail.error.message} title="Mission indisponible" />;
  if (!detail.data) return null;
  const { mission: m, tasks, approvals, active } = detail.data;
  const pending = approvals.filter((a) => a.status === 'pending');
  const uncertain = tasks.filter((t) => t.status === 'blocked' && t.blockReason === 'uncertain_effect');
  const canStart = ['planned', 'paused', 'interrupted'].includes(m.status) && !active;
  const terminal = ['completed', 'failed', 'cancelled'].includes(m.status);
  const doneTasks = tasks.filter((t) => t.status === 'completed').length;

  return (
    <div className="space-y-4">
      <Card
        live={active && m.status === 'running'}
        title={
          <span className="flex flex-wrap items-center gap-2">
            Mission <code className="text-xs font-normal text-faint">{m.id}</code>{' '}
            <StatusBadge status={m.status} />
            {active && <Badge tone="info">exécution active</Badge>}
          </span>
        }
        actions={
          <>
            {canStart && (
              <Button
                variant="primary"
                icon={m.status === 'planned' ? <Play className="size-4" /> : <RotateCcw className="size-4" />}
                pending={start.pending}
                onClick={() => void start.run()}
              >
                {m.status === 'planned' ? 'Démarrer' : 'Reprendre'}
              </Button>
            )}
            {m.status === 'running' && active && (
              <Button
                icon={<Pause className="size-4" />}
                pending={pause.pending}
                onClick={() => void pause.run()}
              >
                Pause
              </Button>
            )}
            {!terminal && (
              <Button
                variant="danger"
                icon={<Square className="size-4" />}
                pending={cancel.pending}
                onClick={() => void cancel.run()}
              >
                Annuler
              </Button>
            )}
            <Button
              variant="ghost"
              icon={<Download className="size-4" />}
              pending={exportReport.pending}
              onClick={() => void exportReport.run()}
            >
              Rapport
            </Button>
            {terminal && (
              <Button
                variant="ghost"
                icon={<Trash2 className="size-4" />}
                pending={deleteMission.pending}
                onClick={() => {
                  if (window.confirm('Supprimer définitivement cette mission et toutes ses données ?'))
                    void deleteMission.run();
                }}
              >
                Supprimer
              </Button>
            )}
          </>
        }
      >
        <p className="text-base font-medium whitespace-pre-wrap">{m.request}</p>
        {tasks.length > 0 && (
          <div className="mt-3">
            <ProgressBar value={doneTasks} max={tasks.length} label="Étapes terminées" />
          </div>
        )}
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-card bg-raised p-3 text-xs text-muted ring-1 ring-line ring-inset sm:grid-cols-4">
          <div>
            <dt>Créée</dt>
            <dd className="mt-0.5 font-medium text-fg tabular-nums">{fmtDate(m.createdAt)}</dd>
          </div>
          <div>
            <dt>Durée</dt>
            <dd className="mt-0.5 font-medium text-fg tabular-nums">{fmtDuration(m.startedAt, m.endedAt)}</dd>
          </div>
          <div>
            <dt>Appels IA / outils</dt>
            <dd className="mt-0.5 font-medium text-fg tabular-nums">
              {m.usage.aiCalls}/{m.budget.maxAiCalls} · {m.usage.toolCalls}/{m.budget.maxToolCalls}
            </dd>
          </div>
          <div>
            <dt>Coût</dt>
            <dd className="mt-0.5 font-medium text-fg tabular-nums">
              {fmtUsd(m.usage.costUsd)} / {fmtUsd(m.budget.maxCostUsd)}
              {!m.usage.costKnown && ' (partiellement inconnu)'}
            </dd>
          </div>
        </dl>
        <div className="mt-3 space-y-2">
          <ErrorBox error={start.error ?? pause.error ?? cancel.error ?? exportReport.error ?? deleteMission.error} />
          {m.error && !terminal && <ErrorBox error={m.error} title="Attention" />}
        </div>
      </Card>

      {pending.length > 0 && (
        <Card title={`Approbations en attente (${pending.length})`}>
          <div className="space-y-2">
            {pending.map((a) => (
              <ApprovalCard key={a.id} approval={a} onDone={reload} />
            ))}
          </div>
        </Card>
      )}

      {uncertain.length > 0 && (
        <Card title="Actions au résultat incertain">
          <p className="mb-2 text-sm">
            Ces étapes ont été interrompues pendant une action non idempotente. Vérifiez l’état réel
            (fichiers, application, site) avant d’autoriser la reprise : l’action pourrait être répétée.
          </p>
          {uncertain.map((t) => (
            <label key={t.id} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirm.includes(t.id)}
                onChange={(e) =>
                  setConfirm((c) => (e.target.checked ? [...c, t.id] : c.filter((x) => x !== t.id)))
                }
              />
              <span>
                <b>{t.stepId}</b> — {t.error}
              </span>
            </label>
          ))}
        </Card>
      )}

      {stream && (m.status === 'planning' || active) && (
        <Card title={`Sortie du modèle en direct${stream.agent ? ` — ${stream.agent}` : ''}`}>
          <pre
            aria-live="polite"
            className="max-h-48 overflow-auto rounded-control bg-raised p-2 font-mono text-xs whitespace-pre-wrap ring-1 ring-line ring-inset"
          >
            {stream.text || (stream.done ? '(appel d’outil, pas de texte)' : '…')}
          </pre>
        </Card>
      )}

      {m.status === 'planning' && <Loading label="Planification en cours…" />}
      {m.plan && (
        <Card title="Plan validé">
          <PlanView plan={m.plan} />
        </Card>
      )}

      {tasks.length > 0 && (
        <Card title="Étapes">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-faint">
                <tr>
                  <th className="py-1 pr-2">Étape</th>
                  <th className="pr-2">Agent</th>
                  <th className="pr-2">Statut</th>
                  <th className="pr-2">Dépend de</th>
                  <th className="pr-2">Tentatives</th>
                  <th className="pr-2">Durée</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    calls={callsByTask.get(t.id) ?? []}
                    stepOf={(id) => tasks.find((x) => x.id === id)?.stepId ?? id}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {m.result && (
        <Card title="Résultat consolidé">
          <div className="mb-2 flex items-center gap-2">
            <StatusBadge status={m.result.status} />
            {m.result.verification && (
              <Badge tone={m.result.verification.verdict === 'pass' ? 'success' : 'danger'}>
                vérification : {m.result.verification.verdict}
              </Badge>
            )}
          </div>
          <p className="text-sm whitespace-pre-wrap">{m.result.summary}</p>
          {m.result.verification && (
            <ul className="mt-2 list-disc pl-5 text-sm text-muted">
              {m.result.verification.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card title="Journal de la mission">
        <EventList events={events.data ?? []} />
      </Card>
    </div>
  );
}

function TaskRow({
  task: t,
  calls,
  stepOf,
}: {
  task: MissionDetail['tasks'][number];
  calls: MissionDetail['toolCalls'];
  stepOf: (id: string) => string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="border-t border-line align-top transition-colors hover:bg-raised">
        <td className="py-1.5 pr-2">
          <button
            type="button"
            className="text-left hover:underline"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <code className="text-xs font-semibold">{t.stepId}</code>{' '}
            <span className="text-muted">{t.objective.slice(0, 90)}</span>
          </button>
        </td>
        <td className="pr-2">
          <Badge tone="info">{t.agent}</Badge>
        </td>
        <td className="pr-2">
          <StatusBadge status={t.status} />
        </td>
        <td className="pr-2 text-xs">{t.dependsOn.map(stepOf).join(', ') || '—'}</td>
        <td className="pr-2 text-xs">
          {t.attempts}/{t.maxAttempts}
        </td>
        <td className="pr-2 text-xs">{fmtDuration(t.startedAt, t.endedAt)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="pb-3">
            <div className="space-y-2 rounded-card bg-raised p-3 ring-1 ring-line ring-inset">
              {t.error && (
                <ErrorBox error={t.error} title={t.status === 'failed' ? 'Échec' : 'Dernier retour'} />
              )}
              {t.result && (
                <div className="text-sm">
                  <p className="font-medium">Résumé de l’agent (affirmation, vérifiée séparément)</p>
                  <p className="whitespace-pre-wrap">{t.result.summary}</p>
                  {t.result.warnings.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-xs text-warning-fg">
                      {t.result.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <p className="text-xs font-medium text-muted">
                Preuves : appels d’outils enregistrés ({calls.length})
              </p>
              <ul className="space-y-1">
                {calls.map((c) => (
                  <li key={c.id}>
                    <details>
                      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-xs">
                        <code>{c.toolId}</code> <StatusBadge status={c.status} />
                        {c.verified === true && <Badge tone="success">post-condition vérifiée</Badge>}
                        {c.verified === false && <Badge tone="danger">non vérifiée</Badge>}
                        <span className="text-muted">{c.durationMs != null ? `${c.durationMs} ms` : ''}</span>
                        {c.error && <span className="text-danger-fg">{c.error.slice(0, 120)}</span>}
                      </summary>
                      <div className="grid gap-2 md:grid-cols-2">
                        <Json value={c.input} />
                        <Json value={c.output ?? c.error} />
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

import { Check, X } from 'lucide-react';
import { api } from '../api';
import { useAction } from '../hooks';
import type { Approval, MissionEvent, Plan } from '../types';
import { Badge, Button, ErrorBox, Json, StatusBadge, fmtDate } from './ui';

/** Human approval bound to one precise action: shows the action, its exact input and consequences. */
export function ApprovalCard({ approval, onDone }: { approval: Approval; onDone?: () => void }) {
  const decide = useAction(
    (decision: 'approved' | 'denied') => api(`/api/approvals/${approval.id}`, { body: { decision } }),
    onDone,
  );
  return (
    <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warning">Approbation requise</Badge>
        <code className="text-xs">{approval.toolId}</code>
        <span className="text-xs text-slate-500">{fmtDate(approval.createdAt)}</span>
      </div>
      <p className="text-sm font-medium">{approval.description}</p>
      <p className="text-sm text-slate-600 dark:text-slate-300">{approval.consequences}</p>
      <details>
        <summary className="cursor-pointer text-xs text-slate-500">Paramètres exacts de l’action</summary>
        <Json value={approval.input} />
      </details>
      {approval.status === 'pending' ? (
        <div className="flex gap-2">
          <Button
            variant="primary"
            icon={<Check className="size-4" />}
            pending={decide.pending}
            onClick={() => void decide.run('approved')}
          >
            Approuver cette action
          </Button>
          <Button
            variant="danger"
            icon={<X className="size-4" />}
            pending={decide.pending}
            onClick={() => void decide.run('denied')}
          >
            Refuser
          </Button>
        </div>
      ) : (
        <StatusBadge status={approval.status} />
      )}
      <ErrorBox error={decide.error} />
    </div>
  );
}

const LEVEL_TONE = { debug: 'neutral', info: 'info', warn: 'warning', error: 'danger' } as const;

export function EventList({
  events,
  empty = 'Aucun événement.',
}: {
  events: MissionEvent[];
  empty?: string;
}) {
  if (!events.length) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ol className="divide-y divide-slate-100 text-sm dark:divide-slate-800" aria-live="polite">
      {[...events].reverse().map((e) => (
        <li key={e.id} className="flex flex-wrap items-baseline gap-2 py-1.5">
          <time className="font-mono text-xs text-slate-500">
            {new Date(e.createdAt).toLocaleTimeString('fr-FR')}
          </time>
          <Badge tone={LEVEL_TONE[e.level]}>{e.category}</Badge>
          <code className="text-xs text-slate-500">{e.type}</code>
          <span className="min-w-0 flex-1 break-words">{e.message}</span>
        </li>
      ))}
    </ol>
  );
}

const RISK_TONE = { low: 'success', medium: 'warning', high: 'danger' } as const;

export function PlanView({ plan }: { plan: Plan }) {
  return (
    <div className="space-y-3">
      <p className="text-sm">{plan.summary}</p>
      <ol className="space-y-2">
        {plan.steps.map((s) => (
          <li key={s.id} className="rounded-md border border-slate-200 p-2.5 dark:border-slate-800">
            <div className="flex flex-wrap items-center gap-2">
              <code className="text-xs font-semibold">{s.id}</code>
              <Badge tone="info">{s.agent}</Badge>
              <Badge tone={RISK_TONE[s.risk]}>risque {s.risk}</Badge>
              {s.dependsOn.length > 0 && (
                <span className="text-xs text-slate-500">après {s.dependsOn.join(', ')}</span>
              )}
              <span className="text-xs text-slate-500">
                {s.timeoutSec} s · {s.maxAttempts} essai(s)
              </span>
            </div>
            <p className="mt-1 text-sm">{s.objective}</p>
            {s.tools.length > 0 && (
              <p className="mt-1 flex flex-wrap gap-1">
                {s.tools.map((t) => (
                  <code key={t} className="rounded bg-slate-100 px-1 text-xs dark:bg-slate-800">
                    {t}
                  </code>
                ))}
              </p>
            )}
            <ul className="mt-1 list-disc pl-5 text-xs text-slate-600 dark:text-slate-400">
              {s.successCriteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <div>
        <p className="text-xs font-medium text-slate-500">Critères de réussite de la mission</p>
        <ul className="list-disc pl-5 text-sm">
          {plan.successCriteria.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

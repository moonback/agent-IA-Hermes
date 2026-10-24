import { Check, X } from 'lucide-react';
import { api } from '../api';
import { useAction } from '../hooks';
import type { Approval, MissionEvent, Plan, Status } from '../types';
import { RISK_LABEL, RISK_TONE } from '../labels';
import { Badge, Button, Code, ErrorBox, Json, StatusBadge, cx, fmtDate } from './ui';

/** Human approval bound to one precise action: shows the action, its exact input and consequences. */
export function ApprovalCard({ approval, onDone }: { approval: Approval; onDone?: () => void }) {
  const decide = useAction(
    (decision: 'approved' | 'denied') => api(`/api/approvals/${approval.id}`, { body: { decision } }),
    onDone,
  );
  return (
    <div className="appear space-y-2 rounded-card bg-warning-soft p-3 ring-1 ring-warning-fg/30 ring-inset">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warning">Approbation requise</Badge>
        <Code>{approval.toolId}</Code>
        <span className="text-xs text-muted">{fmtDate(approval.createdAt)}</span>
      </div>
      <p className="text-sm font-medium">{approval.description}</p>
      <p className="text-sm text-muted">{approval.consequences}</p>
      <details>
        <summary className="cursor-pointer text-xs text-muted hover:text-fg">
          Paramètres exacts de l’action
        </summary>
        <Json value={approval.input} />
      </details>
      {approval.status === 'pending' ? (
        <div className="flex flex-wrap gap-2">
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
const LEVEL_DOT = {
  debug: 'bg-neutral-fg',
  info: 'bg-info-fg',
  warn: 'bg-warning-fg',
  error: 'bg-danger-fg',
} as const;

/** Chronological activity feed (newest first). `compact` drops the event type for narrow panels. */
export function EventList({
  events,
  empty = 'Aucun événement.',
  compact,
  live = true,
}: {
  events: MissionEvent[];
  empty?: string;
  compact?: boolean;
  live?: boolean;
}) {
  if (!events.length) return <p className="py-2 text-sm text-muted">{empty}</p>;
  return (
    <ol className="divide-y divide-line text-sm" aria-live={live ? 'polite' : undefined}>
      {[...events].reverse().map((e) => (
        <li
          key={e.id}
          className={cx('flex gap-2 py-1.5', compact ? 'items-start' : 'flex-wrap items-baseline')}
        >
          <span className={cx('mt-1.5 size-1.5 shrink-0 rounded-full', LEVEL_DOT[e.level])} aria-hidden />
          <time className="shrink-0 font-mono text-xs text-faint" dateTime={e.createdAt}>
            {new Date(e.createdAt).toLocaleTimeString('fr-FR')}
          </time>
          {compact ? (
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 break-words">{e.message}</span>
              <span className="text-xs text-faint">{e.category}</span>
            </span>
          ) : (
            <>
              <Badge tone={LEVEL_TONE[e.level]}>{e.category}</Badge>
              <code className="text-xs text-faint">{e.type}</code>
              <span className="min-w-0 flex-1 break-words">{e.message}</span>
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

export function PlanView({ plan }: { plan: Plan }) {
  return (
    <div className="space-y-3">
      <p className="text-sm">{plan.summary}</p>
      <ol className="space-y-2">
        {plan.steps.map((s) => (
          <li key={s.id} className="rounded-card bg-raised p-2.5 ring-1 ring-line ring-inset">
            <div className="flex flex-wrap items-center gap-2">
              <code className="text-xs font-semibold">{s.id}</code>
              <Badge tone="info">{s.agent}</Badge>
              <Badge tone={RISK_TONE[s.risk]}>risque {RISK_LABEL[s.risk]}</Badge>
              {s.dependsOn.length > 0 && (
                <span className="text-xs text-muted">après {s.dependsOn.join(', ')}</span>
              )}
              <span className="text-xs text-muted">
                {s.timeoutSec} s · {s.maxAttempts} essai(s)
              </span>
            </div>
            <p className="mt-1 text-sm">{s.objective}</p>
            {s.tools.length > 0 && (
              <p className="mt-1 flex flex-wrap gap-1">
                {s.tools.map((t) => (
                  <Code key={t}>{t}</Code>
                ))}
              </p>
            )}
            <ul className="mt-1 list-disc pl-5 text-xs text-muted">
              {s.successCriteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <div>
        <p className="text-xs font-medium text-muted">Critères de réussite de la mission</p>
        <ul className="list-disc pl-5 text-sm">
          {plan.successCriteria.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Shown wherever a mission can be created: planning fails without a key and a primary model. */
export function ProviderWarning({ status }: { status: Status | null }) {
  if (!status) return null;
  const noKey = !status.provider.hasKey;
  const noModel = !status.provider.assignments.primary;
  if (!noKey && !noModel) return null;
  return (
    <ErrorBox
      title="OpenRouter non configuré"
      error={`${noKey ? 'Aucune clé API. ' : ''}${noModel ? 'Aucun modèle principal sélectionné. ' : ''}Configurez-les dans « Modèles et OpenRouter » : la planification échouera sinon.`}
    />
  );
}

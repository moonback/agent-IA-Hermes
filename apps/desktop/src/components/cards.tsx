import { missionTitle } from '../labels';
import { Bot, ChevronRight, Cpu } from 'lucide-react';
import type { AgentInfo, Mission } from '../types';
import { Badge, Code, ProgressBar, StatusBadge, cx, fmtDate, fmtDuration, fmtRelative } from './ui';

/**
 * Summary of one mission. Everything shown comes from the mission record: progress is only drawn
 * once the consolidated result lists the verified steps, and "validation requise" only when real
 * approvals are pending for this mission.
 */
export function MissionCard({
  mission: m,
  pendingApprovals = 0,
  onOpen,
}: {
  mission: Mission;
  pendingApprovals?: number;
  onOpen: () => void;
}) {
  const running = m.status === 'running' || m.status === 'planning';
  const steps = m.result?.tasks;
  const verified = steps?.filter((t) => t.verified).length ?? 0;
  const detail = m.result?.summary ?? m.error;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cx(
        'glass card-hover group flex w-full min-w-0 flex-col gap-2 rounded-card p-3.5 text-left',
        running && 'is-live',
      )}
    >
      <span className="flex w-full flex-wrap items-center gap-2">
        <StatusBadge status={m.status} />
        {pendingApprovals > 0 && (
          <Badge tone="warning">
            validation requise{pendingApprovals > 1 ? ` (${pendingApprovals})` : ''}
          </Badge>
        )}
        <span className="ml-auto text-xs text-faint" title={fmtDate(m.createdAt)}>
          {fmtRelative(m.createdAt)}
        </span>
      </span>
      <span className="line-clamp-2 text-sm font-medium break-words">{missionTitle(m.request)}</span>
      {detail && <span className="line-clamp-2 text-xs break-words text-muted">{detail}</span>}
      {steps && steps.length > 0 && (
        <span className="block w-full">
          <ProgressBar value={verified} max={steps.length} label="Étapes vérifiées" />
        </span>
      )}
      <span className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
        <span className="whitespace-nowrap">Durée {fmtDuration(m.startedAt, m.endedAt)}</span>
        <span className="whitespace-nowrap">
          {m.usage.aiCalls} appel(s) IA · {m.usage.toolCalls} outil(s)
        </span>
        <span className="ml-auto inline-flex items-center gap-0.5 text-accent-fg opacity-80 group-hover:opacity-100">
          Ouvrir <ChevronRight className="size-3.5" aria-hidden />
        </span>
      </span>
    </button>
  );
}

type AgentState = { label: string; tone: 'info' | 'warning' | 'neutral'; live: boolean };

/** State is derived from the runtime registry only: active tasks, configured model. */
export function agentState(a: AgentInfo): AgentState {
  if (a.activeTasks > 0) return { label: `actif (${a.activeTasks})`, tone: 'info', live: true };
  if (!a.model) return { label: 'modèle non configuré', tone: 'warning', live: false };
  return { label: 'au repos', tone: 'neutral', live: false };
}

export function AgentCard({ agent: a, compact }: { agent: AgentInfo; compact?: boolean }) {
  const st = agentState(a);
  const Icon = a.executes ? Bot : Cpu;
  return (
    <article className={cx('glass appear flex min-w-0 flex-col rounded-card p-3.5', st.live && 'is-live')}>
      <header className="flex items-start gap-3">
        <span
          className={cx(
            'grid size-9 shrink-0 place-items-center rounded-control',
            st.live ? 'brand-mark' : 'bg-raised text-accent-fg ring-1 ring-line ring-inset',
          )}
          aria-hidden
        >
          <Icon className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-x-2 text-sm font-semibold">
            {a.name} <code className="text-xs font-normal text-faint">{a.id}</code>
          </h3>
          <p className={cx('text-xs text-muted', compact && 'line-clamp-2')}>{a.role}</p>
        </div>
        <Badge tone={st.tone} icon={st.live ? <span className="live-dot size-1.5" aria-hidden /> : undefined}>
          {st.label}
        </Badge>
      </header>
      {compact ? (
        <p className="mt-2 text-xs text-faint">
          Dernière exécution : {fmtRelative(a.stats?.lastRunAt)} · {a.stats?.runs ?? 0} exécution(s)
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-1">
            {a.capabilities.map((c) => (
              <Badge key={c}>{c}</Badge>
            ))}
          </div>
          <dl className="mt-3 divide-y divide-line text-xs">
            <div className="flex justify-between gap-2 py-1">
              <dt className="text-muted">Modèle ({a.modelRole})</dt>
              <dd className="min-w-0 truncate">
                <code>{a.model?.modelId ?? 'non configuré'}</code>
              </dd>
            </div>
            {a.model && a.model.fallbacks.length > 0 && (
              <div className="flex justify-between gap-2 py-1">
                <dt className="text-muted">Secours</dt>
                <dd className="min-w-0 truncate">{a.model.fallbacks.join(', ')}</dd>
              </div>
            )}
            {a.executes && (
              <div className="flex justify-between gap-2 py-1">
                <dt className="text-muted">Limites</dt>
                <dd>
                  {a.limits.maxIterations} itérations · {a.limits.maxToolCallsPerTask} outils / tâche
                </dd>
              </div>
            )}
            <div className="flex justify-between gap-2 py-1">
              <dt className="text-muted">Exécutions / échecs</dt>
              <dd className="tabular-nums">
                {a.stats?.runs ?? 0} / {a.stats?.failures ?? 0}
              </dd>
            </div>
            <div className="flex justify-between gap-2 py-1">
              <dt className="text-muted">Dernière exécution</dt>
              <dd>{fmtDate(a.stats?.lastRunAt)}</dd>
            </div>
          </dl>
          {a.tools.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {a.tools.map((t) => (
                <Code key={t}>{t}</Code>
              ))}
            </div>
          )}
        </>
      )}
      {a.stats?.lastError && (
        <p className="mt-2 rounded-control bg-danger-soft px-2 py-1 text-xs break-words text-danger-fg">
          Dernière erreur : {compact ? a.stats.lastError.slice(0, 120) : a.stats.lastError}
        </p>
      )}
    </article>
  );
}

/** Selectable row of a mission list (Missions, Chat). */
export function MissionListItem({
  mission: m,
  selected,
  onSelect,
}: {
  mission: Mission;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      onClick={onSelect}
      className={cx(
        'press relative flex w-full flex-col items-start gap-1 rounded-control p-2 text-left text-sm ring-inset',
        selected ? 'bg-info-soft ring-1 ring-accent-fg/40' : 'hover:bg-neutral-soft',
      )}
    >
      <span className="flex w-full items-center gap-2">
        <StatusBadge status={m.status} />
        <span className="ml-auto text-xs text-faint" title={fmtDate(m.createdAt)}>
          {fmtRelative(m.createdAt)}
        </span>
      </span>
      <span className="line-clamp-2 break-words">{missionTitle(m.request)}</span>
    </button>
  );
}

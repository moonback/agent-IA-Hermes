import { useResource } from '../hooks';
import type { AgentInfo } from '../types';
import { Badge, Card, ErrorBox, Loading, PageHeader, fmtDate } from '../components/ui';

export function AgentsPage() {
  const agents = useResource<AgentInfo[]>('/api/agents');
  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="Rôles, capacités, outils, modèle OpenRouter, limites et dernières erreurs"
      />
      {agents.loading && !agents.data && <Loading />}
      <ErrorBox error={agents.error?.message} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {agents.data?.map((a) => (
          <Card
            key={a.id}
            title={
              <span className="flex items-center gap-2">
                {a.name} <code className="text-xs text-slate-500">{a.id}</code>
              </span>
            }
            actions={
              a.activeTasks > 0 ? <Badge tone="info">actif ({a.activeTasks})</Badge> : <Badge>au repos</Badge>
            }
          >
            <p className="text-sm">{a.role}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {a.capabilities.map((c) => (
                <Badge key={c}>{c}</Badge>
              ))}
            </div>
            <dl className="mt-3 space-y-1 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Modèle ({a.modelRole})</dt>
                <dd>
                  <code>{a.model?.modelId ?? 'non configuré'}</code>
                </dd>
              </div>
              {a.model && a.model.fallbacks.length > 0 && (
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Secours</dt>
                  <dd>{a.model.fallbacks.join(', ')}</dd>
                </div>
              )}
              {a.executes && (
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Limites</dt>
                  <dd>
                    {a.limits.maxIterations} itérations · {a.limits.maxToolCallsPerTask} outils / tâche
                  </dd>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Exécutions / échecs</dt>
                <dd>
                  {a.stats?.runs ?? 0} / {a.stats?.failures ?? 0}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Dernière exécution</dt>
                <dd>{fmtDate(a.stats?.lastRunAt)}</dd>
              </div>
            </dl>
            {a.tools.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {a.tools.map((t) => (
                  <code key={t} className="rounded bg-slate-100 px-1 text-xs dark:bg-slate-800">
                    {t}
                  </code>
                ))}
              </div>
            )}
            {a.stats?.lastError && (
              <p className="mt-2 text-xs break-words text-red-600 dark:text-red-400">
                Dernière erreur : {a.stats.lastError}
              </p>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}

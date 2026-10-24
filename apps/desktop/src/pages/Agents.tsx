import { Activity, AlertTriangle, Bot, Cpu } from 'lucide-react';
import { useResource } from '../hooks';
import type { AgentInfo } from '../types';
import { AgentCard } from '../components/cards';
import { Empty, ErrorBox, Loading, PageHeader, Stat } from '../components/ui';

export function AgentsPage() {
  const agents = useResource<AgentInfo[]>('/api/agents');
  const list = agents.data ?? [];
  const executors = list.filter((a) => a.executes);
  const support = list.filter((a) => !a.executes);
  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="Rôles, capacités, outils, modèle OpenRouter, limites et dernières erreurs"
      />
      {agents.loading && !agents.data && <Loading />}
      <ErrorBox error={agents.error?.message} />
      {agents.data && (
        <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-3">
          <Stat label="Agents enregistrés" value={list.length} icon={<Bot className="size-4" />} />
          <Stat
            label="Actifs maintenant"
            value={list.filter((a) => a.activeTasks > 0).length}
            icon={<Activity className="size-4" />}
            hint={`${list.reduce((n, a) => n + a.activeTasks, 0)} tâche(s) en cours`}
          />
          <Stat
            label="Sans modèle configuré"
            value={list.filter((a) => !a.model).length}
            icon={<Cpu className="size-4" />}
            tone="warning"
          />
          <Stat
            label="Avec une erreur enregistrée"
            value={list.filter((a) => a.stats?.lastError).length}
            icon={<AlertTriangle className="size-4" />}
            tone="danger"
            hint="Dernière erreur connue, pas forcément récente"
          />
        </div>
      )}
      {agents.data?.length === 0 && <Empty>Aucun agent enregistré dans le runtime.</Empty>}
      {executors.length > 0 && (
        <section aria-labelledby="agents-exec" className="mb-5">
          <h2 id="agents-exec" className="mb-2 text-sm font-semibold text-muted">
            Agents exécutants ({executors.length})
          </h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {executors.map((a) => (
              <AgentCard key={a.id} agent={a} />
            ))}
          </div>
        </section>
      )}
      {support.length > 0 && (
        <section aria-labelledby="agents-support">
          <h2 id="agents-support" className="mb-2 text-sm font-semibold text-muted">
            Planification et vérification ({support.length})
          </h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {support.map((a) => (
              <AgentCard key={a.id} agent={a} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

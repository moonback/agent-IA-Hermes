import { useMemo, useState, type ReactNode } from 'react';
import { Activity, Bot, Cable, Cpu, LayoutGrid, List, Network } from 'lucide-react';
import { api } from '../api';
import { useAction, useResource } from '../hooks';
import { useApp } from '../store';
import type { AgentInfo } from '../types';
import { AgentCard } from '../components/cards';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Input,
  Loading,
  PageHeader,
  Select,
  Stat,
  Textarea,
} from '../components/ui';

type AgentView = 'cards' | 'details' | 'network';
const EMPTY_AGENTS: AgentInfo[] = [];

const VIEWS: { id: AgentView; label: string; icon: ReactNode }[] = [
  { id: 'cards', label: 'Cartes', icon: <LayoutGrid className="size-4" /> },
  { id: 'details', label: 'Détails', icon: <List className="size-4" /> },
  { id: 'network', label: 'Orchestration', icon: <Network className="size-4" /> },
];

export function AgentsPage() {
  const agents = useResource<AgentInfo[]>('/api/agents');
  const [view, setView] = useState<AgentView>('cards');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const navigate = useApp((state) => state.navigate);
  const list = agents.data ?? EMPTY_AGENTS;
  const executors = list.filter((agent) => agent.executes);
  const support = list.filter((agent) => !agent.executes);
  const selected = useMemo(() => list.find((agent) => agent.id === selectedId) ?? null, [list, selectedId]);

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="Registre des rôles, capacités et exécutions réellement observées dans le runtime."
        actions={
          <div className="flex flex-wrap gap-1" role="group" aria-label="Mode d’affichage des agents">
            {VIEWS.map((item) => (
              <Button
                key={item.id}
                variant={view === item.id ? 'secondary' : 'ghost'}
                aria-pressed={view === item.id}
                onClick={() => setView(item.id)}
                icon={item.icon}
              >
                {item.label}
              </Button>
            ))}
          </div>
        }
      />
      {agents.loading && !agents.data && <Loading />}
      <ErrorBox error={agents.error?.message} />
      {agents.data && (
        <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-3">
          <Stat label="Agents enregistrés" value={list.length} icon={<Bot className="size-4" />} />
          <Stat
            label="Agents avec tâches actives"
            value={list.filter((agent) => agent.activeTasks > 0).length}
            icon={<Activity className="size-4" />}
            hint={`${list.reduce((total, agent) => total + agent.activeTasks, 0)} tâche(s) actives selon le runtime`}
          />
          <Stat
            label="Sans modèle configuré"
            value={list.filter((agent) => !agent.model).length}
            icon={<Cpu className="size-4" />}
            tone="warning"
          />
        </div>
      )}
      {agents.data?.length === 0 && <Empty>Aucun agent enregistré dans le runtime.</Empty>}
      {view === 'cards' && agents.data && (
        <div className="space-y-5">
          <AgentGroup id="agents-exec" title={`Agents exécutants (${executors.length})`} agents={executors} />
          <AgentGroup
            id="agents-support"
            title={`Orchestration, planification et vérification (${support.length})`}
            agents={support}
          />
        </div>
      )}
      {view === 'details' && agents.data && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
          <Card title="Fiches agents">
            <div className="grid gap-2 md:grid-cols-2">
              {list.map((agent) => (
                <button
                  type="button"
                  key={agent.id}
                  aria-pressed={selectedId === agent.id}
                  onClick={() => setSelectedId(agent.id)}
                  className={`rounded-card text-left ${selectedId === agent.id ? 'ring-2 ring-accent-fg' : ''}`}
                >
                  <AgentCard agent={agent} compact />
                </button>
              ))}
            </div>
          </Card>
          {selected ? (
            <AgentDetails agent={selected} onSaved={agents.reload} />
          ) : (
            <Card>
              <Empty>Sélectionnez un agent pour consulter sa fiche.</Empty>
            </Card>
          )}
        </div>
      )}
      {view === 'network' && agents.data && (
        <div className="space-y-4">
          <Card title="Registre d’orchestration" icon={<Network className="size-4" />}>
            <p className="mb-4 text-sm text-muted">
              Les liens affichés viennent des attributions réelles des tâches en cours ou en attente
              d’approbation. Les agents sans tâche active restent sans connexion dans cette vue.
            </p>
            <div className="grid gap-4 lg:grid-cols-2">
              <AgentNetworkGroup
                title="Orchestration et support"
                agents={support}
                onSelect={setSelectedId}
                onOpenMission={(id) => navigate('missions', id)}
              />
              <AgentNetworkGroup
                title="Exécution des tâches"
                agents={executors}
                onSelect={setSelectedId}
                onOpenMission={(id) => navigate('missions', id)}
              />
            </div>
          </Card>
          {selected && <AgentDetails agent={selected} onSaved={agents.reload} />}
        </div>
      )}
    </>
  );
}

function AgentGroup({ id, title, agents }: { id: string; title: string; agents: AgentInfo[] }) {
  if (!agents.length) return null;
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="mb-2 text-sm font-semibold text-muted">
        {title}
      </h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </section>
  );
}

function AgentNetworkGroup({
  title,
  agents,
  onSelect,
  onOpenMission,
}: {
  title: string;
  agents: AgentInfo[];
  onSelect: (id: string) => void;
  onOpenMission: (id: string) => void;
}) {
  return (
    <section className="min-w-0 rounded-card bg-raised p-3 ring-1 ring-line ring-inset">
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
        <Cable className="size-4" aria-hidden /> {title}
      </h3>
      {agents.length ? (
        <ul className="space-y-2">
          {agents.map((agent) => (
            <li key={agent.id} className="relative">
              <button
                type="button"
                onClick={() => onSelect(agent.id)}
                className="flex w-full items-center gap-3 rounded-control bg-surface p-3 text-left ring-1 ring-line ring-inset hover:ring-line-strong"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{agent.name}</span>
                  <span className="block truncate text-xs text-muted">{agent.role}</span>
                </span>
                <Badge tone={agent.activeTasks ? 'info' : 'neutral'}>
                  {agent.activeTasks ? `${agent.activeTasks} tâche(s)` : 'aucune tâche active'}
                </Badge>
              </button>
              {agent.activeMissionIds.length > 0 && (
                <div className="ml-5 border-l border-line py-2 pl-3">
                  <p className="mb-1 text-xs text-faint">Attributions observées · ouvrir une mission</p>
                  <div className="flex flex-wrap gap-1">
                    {agent.activeMissionIds.map((missionId) => (
                      <button
                        type="button"
                        key={missionId}
                        onClick={() => onOpenMission(missionId)}
                        className="rounded bg-info-soft px-2 py-1 font-mono text-xs text-info-fg hover:underline"
                      >
                        ↳ {missionId}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Aucun agent dans ce groupe.</Empty>
      )}
    </section>
  );
}

function AgentDetails({ agent, onSaved }: { agent: AgentInfo; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <Card
      title={`${agent.name} · fiche agent`}
      actions={
        <Button onClick={() => setEditing((current) => !current)}>
          {editing ? 'Fermer la modification' : 'Modifier cet agent'}
        </Button>
      }
    >
      {editing && (
        <AgentEditor
          key={agent.id}
          agent={agent}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onSaved();
          }}
        />
      )}
      <p className="text-sm text-muted">{agent.role}</p>
      <dl className="mt-3 grid gap-2 rounded-card bg-raised p-3 text-sm ring-1 ring-line ring-inset sm:grid-cols-2">
        <div>
          <dt className="text-xs text-faint">Identifiant</dt>
          <dd>
            <code>{agent.id}</code>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-faint">Tâches actives</dt>
          <dd>{agent.activeTasks}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-faint">Missions reliées à des tâches actives</dt>
          <dd className="mt-1 flex flex-wrap gap-1">
            {agent.activeMissionIds.length
              ? agent.activeMissionIds.map((id) => <Badge key={id}>{id}</Badge>)
              : 'Aucune attribution active'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-faint">Modèle · rôle</dt>
          <dd className="break-all">
            <code>{agent.model?.modelId ?? 'Non configuré'}</code> · {agent.modelRole}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-faint">Exécutions / échecs</dt>
          <dd>{agent.stats ? `${agent.stats.runs} / ${agent.stats.failures}` : 'Indisponible'}</dd>
        </div>
        {agent.executes && (
          <div>
            <dt className="text-xs text-faint">Limites</dt>
            <dd>
              {agent.limits.maxIterations} itérations · {agent.limits.maxToolCallsPerTask} outils par tâche
            </dd>
          </div>
        )}
      </dl>
      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Capacités</h3>
      <div className="mt-2 flex flex-wrap gap-1">
        {agent.capabilities.map((capability) => (
          <Badge key={capability}>{capability}</Badge>
        ))}
      </div>
      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Outils déclarés</h3>
      {agent.tools.length ? (
        <ul className="mt-2 flex flex-wrap gap-1">
          {agent.tools.map((tool) => (
            <li key={tool}>
              <Badge>{tool}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">Aucun outil d’exécution déclaré.</p>
      )}
      {agent.stats?.lastError && (
        <p className="mt-4 rounded-control bg-danger-soft p-3 text-sm text-danger-fg">
          Dernière erreur enregistrée : {agent.stats.lastError}
        </p>
      )}
    </Card>
  );
}

function AgentEditor({
  agent,
  onCancel,
  onSaved,
}: {
  agent: AgentInfo;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role);
  const [capabilities, setCapabilities] = useState(agent.capabilities.join('\n'));
  const [modelRole, setModelRole] = useState(agent.modelRole);
  const [maxIterations, setMaxIterations] = useState(agent.limits.maxIterations);
  const [maxToolCallsPerTask, setMaxToolCallsPerTask] = useState(agent.limits.maxToolCallsPerTask);
  const save = useAction(
    () =>
      api(`/api/agents/${encodeURIComponent(agent.id)}`, {
        method: 'PATCH',
        body: {
          name,
          role,
          capabilities: capabilities
            .split('\n')
            .map((item) => item.trim())
            .filter(Boolean),
          ...(agent.executes && agent.activeTasks === 0
            ? { modelRole, limits: { maxIterations, maxToolCallsPerTask } }
            : {}),
        },
      }),
    onSaved,
  );
  return (
    <form
      className="mb-4 space-y-3 rounded-card bg-raised p-3 ring-1 ring-line ring-inset"
      onSubmit={(event) => {
        event.preventDefault();
        void save.run();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`agent-name-${agent.id}`} label="Nom">
          <Input
            id={`agent-name-${agent.id}`}
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field id={`agent-role-${agent.id}`} label="Description du rôle">
          <Input
            id={`agent-role-${agent.id}`}
            value={role}
            maxLength={400}
            onChange={(event) => setRole(event.target.value)}
          />
        </Field>
      </div>
      <Field id={`agent-capabilities-${agent.id}`} label="Capacités (une par ligne)">
        <Textarea
          id={`agent-capabilities-${agent.id}`}
          rows={3}
          value={capabilities}
          onChange={(event) => setCapabilities(event.target.value)}
        />
      </Field>
      {agent.executes && (
        <>
          {agent.activeTasks > 0 && (
            <p className="text-xs text-warning-fg">
              Le modèle et les limites sont verrouillés tant que cet agent a des tâches actives.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field id={`agent-model-role-${agent.id}`} label="Rôle de modèle">
              <Select
                id={`agent-model-role-${agent.id}`}
                value={modelRole}
                disabled={agent.activeTasks > 0}
                onChange={(event) => setModelRole(event.target.value as typeof modelRole)}
              >
                <option value="primary">Principal</option>
                <option value="planning">Planification</option>
                <option value="execution">Exécution</option>
                <option value="verification">Vérification</option>
              </Select>
            </Field>
            <Field id={`agent-iterations-${agent.id}`} label="Limite d’itérations (1–50)">
              <Input
                id={`agent-iterations-${agent.id}`}
                type="number"
                min={1}
                max={50}
                value={maxIterations}
                disabled={agent.activeTasks > 0}
                onChange={(event) => setMaxIterations(Number(event.target.value))}
              />
            </Field>
            <Field id={`agent-tools-${agent.id}`} label="Outils par tâche (1–100)">
              <Input
                id={`agent-tools-${agent.id}`}
                type="number"
                min={1}
                max={100}
                value={maxToolCallsPerTask}
                disabled={agent.activeTasks > 0}
                onChange={(event) => setMaxToolCallsPerTask(Number(event.target.value))}
              />
            </Field>
          </div>
          <p className="text-xs text-muted">
            Le rôle de modèle utilise l’affectation correspondante dans Modèles et OpenRouter. Ces limites
            s’appliquent aux prochaines tâches.
          </p>
        </>
      )}
      <p className="text-xs text-faint">
        Les instructions internes et les permissions d’outils restent gérées par HERMES.
      </p>
      <ErrorBox error={save.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Annuler
        </Button>
        <Button
          type="submit"
          variant="primary"
          pending={save.pending}
          disabled={name.trim().length < 2 || role.trim().length < 2}
        >
          Enregistrer
        </Button>
      </div>
    </form>
  );
}

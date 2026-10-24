import { useState, type ReactNode } from 'react';
import {
  Activity,
  Bot,
  Brain,
  CircleCheck,
  Coins,
  ListChecks,
  Monitor,
  Send,
  ShieldAlert,
  Sparkles,
  Zap,
} from 'lucide-react';
import { api } from '../api';
import { useAction, useResource } from '../hooks';
import { useApp } from '../store';
import type { AgentInfo, Approval, Mission, MissionEvent, Status } from '../types';
import { connectionState } from '../labels';
import { ApprovalCard, EventList, ProviderWarning } from '../components/shared';
import { AgentCard, MissionCard } from '../components/cards';
import {
  Badge,
  Button,
  Card,
  DataList,
  Empty,
  ErrorBox,
  Loading,
  PageHeader,
  Stat,
  Textarea,
  fmtDate,
  fmtUsd,
} from '../components/ui';

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 || h >= 18 ? 'Bonsoir' : 'Bonjour';
};

export function DashboardPage() {
  const status = useResource<Status>('/api/status');
  const recent = useResource<Mission[]>('/api/missions?limit=6');
  const approvals = useResource<Approval[]>('/api/approvals?status=pending');
  const events = useResource<MissionEvent[]>('/api/events?limit=25');
  const agents = useResource<AgentInfo[]>('/api/agents');
  const connected = useApp((s) => s.connected);
  const navigate = useApp((s) => s.navigate);
  const s = status.data;

  const pendingByMission = new Map<string, number>();
  for (const a of approvals.data ?? [])
    pendingByMission.set(a.missionId, (pendingByMission.get(a.missionId) ?? 0) + 1);

  const [label, tone] = s ? connectionState(s.provider) : (['—', 'neutral'] as const);
  const serviceLine = !connected
    ? 'Le service local ne répond pas : les données affichées peuvent être anciennes.'
    : s?.halted
      ? 'Arrêt d’urgence actif : aucune action ne sera exécutée avant réarmement.'
      : 'Service local opérationnel. Décrivez une mission : HERMES propose un plan que vous validez.';

  return (
    <>
      <PageHeader title="Tableau de bord" subtitle="État réel du système, des missions et des agents" />
      <ErrorBox error={status.error?.message} />

      <section
        aria-labelledby="welcome-title"
        className="glass appear relative mb-4 grid gap-5 overflow-hidden rounded-panel p-5 lg:grid-cols-[1fr_20rem]"
      >
        <div className="min-w-0">
          <h2 id="welcome-title" className="flex items-center gap-2 text-lg font-semibold">
            <Sparkles className="size-5 text-accent-fg" aria-hidden /> {greeting()}
          </h2>
          <p className="mt-1 text-sm text-muted">{serviceLine}</p>
          <QuickMission status={s} />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="ghost"
              icon={<ListChecks className="size-4" />}
              onClick={() => navigate('missions')}
            >
              Toutes les missions
            </Button>
            <Button
              variant="ghost"
              icon={<Monitor className="size-4" />}
              onClick={() => navigate('computer')}
            >
              Observer le bureau
            </Button>
            <Button variant="ghost" icon={<Brain className="size-4" />} onClick={() => navigate('models')}>
              Configurer les modèles
            </Button>
          </div>
        </div>
        <div className="min-w-0 rounded-card bg-raised p-3 ring-1 ring-line ring-inset">
          <h3 className="mb-1 text-xs font-semibold tracking-wider text-faint uppercase">
            Fournisseur et workers
          </h3>
          {status.loading && !s && <Loading />}
          {s && (
            <DataList
              rows={[
                ['OpenRouter', <Badge tone={tone}>{label}</Badge>],
                ['Dernier test', fmtDate(s.provider.lastTest?.testedAt)],
                [
                  'Gemini',
                  !s.provider.gemini.hasKey ? (
                    <Badge tone="neutral">non configuré</Badge>
                  ) : s.provider.gemini.lastTest || s.provider.gemini.liveTest ? (
                    <Badge
                      tone={
                        (s.provider.gemini.liveTest ?? s.provider.gemini.lastTest)!.ok ? 'success' : 'warning'
                      }
                    >
                      {(s.provider.gemini.liveTest ?? s.provider.gemini.lastTest)!.ok
                        ? 'test réussi'
                        : 'test en échec'}
                    </Badge>
                  ) : (
                    <Badge tone="neutral">clé présente, non testée</Badge>
                  ),
                ],
                [
                  'Modèle principal',
                  <code className="text-xs">
                    {s.provider.assignments.primary?.modelId ?? 'non configuré'}
                  </code>,
                  s.provider.assignments.primary?.modelId,
                ],
                ...(
                  [
                    ['Bureau Windows', s.workers.desktop],
                    ['Navigateur', s.workers.browser],
                    ['Recherche Web', s.workers.search],
                  ] as const
                ).map(
                  ([name, a]) =>
                    [
                      name,
                      <Badge tone={a.available ? 'success' : 'warning'}>
                        {a.available ? 'disponible' : 'indisponible'}
                      </Badge>,
                      a.reason,
                    ] as [string, ReactNode, string?],
                ),
              ]}
            />
          )}
        </div>
      </section>

      {s && (
        <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3">
          <Stat
            label="Missions actives"
            value={s.missions.active.length}
            icon={<Activity className="size-4" />}
            hint={`${s.workers.activeLoops} boucle(s) d’agent`}
          />
          <Stat
            label="Décisions en attente"
            value={s.missions.pendingApprovals}
            icon={<ShieldAlert className="size-4" />}
            tone={s.missions.pendingApprovals > 0 ? 'warning' : 'neutral'}
          />
          <Stat label="Appels IA mesurés" value={s.usage.aiCalls} icon={<Zap className="size-4" />} />
          <Stat
            label="Coût mesuré"
            value={fmtUsd(s.usage.costUsd)}
            icon={<Coins className="size-4" />}
            tone="neutral"
          />
          <Stat
            label="Réussies / échouées"
            value={`${s.usage.outcomes.completed ?? 0} / ${s.usage.outcomes.failed ?? 0}`}
            icon={<CircleCheck className="size-4" />}
            tone="success"
            hint={`${s.usage.agentRuns} exécution(s) d’agent`}
          />
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_24rem]">
        <Card
          title="Missions récentes"
          icon={<ListChecks className="size-4" />}
          actions={
            <Button variant="ghost" onClick={() => navigate('missions')}>
              Tout voir
            </Button>
          }
        >
          {recent.loading && !recent.data && <Loading />}
          <ErrorBox error={recent.error?.message} />
          {recent.data?.length === 0 && (
            <Empty icon={<ListChecks className="size-5" />}>Aucune mission pour l’instant.</Empty>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            {recent.data?.map((m) => (
              <MissionCard
                key={m.id}
                mission={m}
                pendingApprovals={pendingByMission.get(m.id)}
                onOpen={() => navigate('missions', m.id)}
              />
            ))}
          </div>
        </Card>

        <Card
          title={`En attente d’approbation (${approvals.data?.length ?? 0})`}
          icon={<ShieldAlert className="size-4" />}
        >
          <ErrorBox error={approvals.error?.message} />
          {approvals.data?.length ? (
            <div className="space-y-2">
              {approvals.data.map((a) => (
                <ApprovalCard key={a.id} approval={a} onDone={approvals.reload} />
              ))}
            </div>
          ) : (
            <Empty icon={<CircleCheck className="size-5" />}>Aucune action n’attend votre décision.</Empty>
          )}
        </Card>
      </div>

      <Card
        className="mt-4"
        title="Agents"
        icon={<Bot className="size-4" />}
        actions={
          <Button variant="ghost" onClick={() => navigate('agents')}>
            Détails
          </Button>
        }
      >
        {agents.loading && !agents.data && <Loading />}
        <ErrorBox error={agents.error?.message} />
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {agents.data?.map((a) => (
            <AgentCard key={a.id} agent={a} compact />
          ))}
        </div>
      </Card>

      <Card className="mt-4" title="Activité récente" icon={<Activity className="size-4" />}>
        <ErrorBox error={events.error?.message} />
        <EventList events={events.data ?? []} />
      </Card>

      {s && (
        <Card className="mt-4" title="Système">
          <DataList
            rows={[
              [
                'État',
                s.halted ? (
                  <Badge tone="danger">arrêt d’urgence</Badge>
                ) : (
                  <Badge tone="success">opérationnel</Badge>
                ),
              ],
              ['Démarrage du service', `${s.startupMs} ms`],
              ['Données', <code className="text-xs">{s.dataDir}</code>, s.dataDir],
            ]}
          />
        </Card>
      )}
    </>
  );
}

/** Same creation call as the Chat page; the new mission then opens there with its plan. */
function QuickMission({ status }: { status: Status | null }) {
  const [text, setText] = useState('');
  const navigate = useApp((s) => s.navigate);
  const create = useAction(
    (request: string) => api<Mission>('/api/missions', { body: { request } }),
    (m) => {
      setText('');
      navigate('chat', m.id);
    },
  );
  return (
    <form
      className="mt-4 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim().length >= 2) void create.run(text.trim());
      }}
    >
      <label htmlFor="quick-mission" className="sr-only">
        Décrire une mission
      </label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Textarea
          id="quick-mission"
          rows={2}
          maxLength={8000}
          value={text}
          placeholder="Ex. : Classe les PDF du dossier de travail par année et prépare un rapport."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey))
              (e.currentTarget.form as HTMLFormElement).requestSubmit();
          }}
          className="min-h-[3.25rem] resize-y"
        />
        <Button
          type="submit"
          variant="primary"
          icon={<Send className="size-4" />}
          pending={create.pending}
          disabled={text.trim().length < 2}
          className="shrink-0 py-2"
        >
          Planifier la mission
        </Button>
      </div>
      <ProviderWarning status={status} />
      <ErrorBox error={create.error} />
    </form>
  );
}

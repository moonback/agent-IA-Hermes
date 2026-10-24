import { useResource } from '../hooks';
import { useApp } from '../store';
import type { Approval, Mission, MissionEvent, Status } from '../types';
import { ApprovalCard, EventList } from '../components/shared';
import {
  Badge,
  Card,
  Empty,
  ErrorBox,
  Loading,
  PageHeader,
  StatusBadge,
  fmtDate,
  fmtUsd,
  type Tone,
} from '../components/ui';

export const CONNECTION_LABEL: Record<string, [string, Tone]> = {
  ok: ['Connecté (test réussi)', 'success'],
  config_missing: ['Configuration manquante', 'warning'],
  auth_invalid: ['Clé invalide ou accès refusé', 'danger'],
  network: ['Problème réseau', 'danger'],
  model_unavailable: ['Modèle indisponible', 'danger'],
  insufficient_credits: ['Crédit insuffisant', 'danger'],
  rate_limited: ['Limite de débit', 'warning'],
  provider_error: ['Erreur fournisseur', 'danger'],
};

export function DashboardPage() {
  const status = useResource<Status>('/api/status');
  const recent = useResource<Mission[]>('/api/missions?limit=8');
  const approvals = useResource<Approval[]>('/api/approvals?status=pending');
  const events = useResource<MissionEvent[]>('/api/events?limit=25');
  const navigate = useApp((s) => s.navigate);
  const s = status.data;

  const test = s?.provider.lastTest;
  const [label, tone]: [string, Tone] = !s?.provider.hasKey
    ? CONNECTION_LABEL.config_missing!
    : test
      ? (CONNECTION_LABEL[test.status] ?? ['Inconnu', 'neutral'])
      : ['Clé présente, non testée', 'neutral'];

  return (
    <>
      <PageHeader title="Tableau de bord" subtitle="État réel du système, des missions et des workers" />
      {status.loading && !s && <Loading />}
      <ErrorBox error={status.error?.message} />
      {s && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Système">
            <ul className="space-y-1.5 text-sm">
              <li className="flex justify-between">
                <span>État</span>
                {s.halted ? (
                  <Badge tone="danger">arrêt d’urgence</Badge>
                ) : (
                  <Badge tone="success">opérationnel</Badge>
                )}
              </li>
              <li className="flex justify-between">
                <span>Démarrage du service</span>
                <span>{s.startupMs} ms</span>
              </li>
              <li className="flex justify-between gap-2">
                <span>Données</span>
                <code className="truncate text-xs" title={s.dataDir}>
                  {s.dataDir}
                </code>
              </li>
            </ul>
          </Card>
          <Card title="OpenRouter">
            <ul className="space-y-1.5 text-sm">
              <li className="flex justify-between gap-2">
                <span>Connexion</span>
                <Badge tone={tone}>{label}</Badge>
              </li>
              <li className="flex justify-between">
                <span>Dernier test</span>
                <span>{fmtDate(test?.testedAt)}</span>
              </li>
              <li className="flex justify-between gap-2">
                <span>Modèle principal</span>
                <code className="truncate text-xs">
                  {s.provider.assignments.primary?.modelId ?? 'non configuré'}
                </code>
              </li>
              {test?.key && (
                <li className="flex justify-between">
                  <span>Crédit (clé)</span>
                  <span>
                    {fmtUsd(test.key.usageUsd)} utilisés
                    {test.key.limitUsd != null ? ` / ${fmtUsd(test.key.limitUsd)}` : ''}
                  </span>
                </li>
              )}
            </ul>
          </Card>
          <Card title="Workers">
            <ul className="space-y-1.5 text-sm">
              {(
                [
                  ['Bureau Windows (UI Automation)', s.workers.desktop],
                  ['Navigateur (Playwright)', s.workers.browser],
                  ['Recherche Web', s.workers.search],
                ] as const
              ).map(([name, a]) => (
                <li key={name} className="flex justify-between gap-2" title={a.reason}>
                  <span>{name}</span>
                  <Badge tone={a.available ? 'success' : 'warning'}>
                    {a.available ? 'disponible' : 'indisponible'}
                  </Badge>
                </li>
              ))}
              <li className="flex justify-between">
                <span>Boucles actives</span>
                <span>{s.workers.activeLoops}</span>
              </li>
            </ul>
          </Card>
          <Card title="Consommation IA (totale mesurée)">
            <ul className="space-y-1.5 text-sm">
              <li className="flex justify-between">
                <span>Appels IA</span>
                <span>{s.usage.aiCalls}</span>
              </li>
              <li className="flex justify-between">
                <span>Coût mesuré</span>
                <span>{fmtUsd(s.usage.costUsd)}</span>
              </li>
              <li className="flex justify-between">
                <span>Missions réussies / échouées</span>
                <span>
                  {s.usage.outcomes.completed ?? 0} / {s.usage.outcomes.failed ?? 0}
                </span>
              </li>
            </ul>
          </Card>
          <Card title={`Missions actives (${s.missions.active.length})`} className="lg:col-span-2">
            {s.missions.active.length === 0 ? (
              <Empty>Aucune mission en cours.</Empty>
            ) : (
              <ul className="space-y-1">
                {s.missions.active.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 text-left text-sm hover:underline"
                      onClick={() => navigate('missions', m.id)}
                    >
                      <StatusBadge status={m.status} /> <span className="truncate">{m.request}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title={`En attente d’approbation (${approvals.data?.length ?? 0})`}>
          {approvals.data?.length ? (
            <div className="space-y-2">
              {approvals.data.map((a) => (
                <ApprovalCard key={a.id} approval={a} onDone={approvals.reload} />
              ))}
            </div>
          ) : (
            <Empty>Aucune action n’attend votre décision.</Empty>
          )}
        </Card>
        <Card title="Dernières missions">
          {recent.data?.length ? (
            <ul className="space-y-1">
              {recent.data.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 text-left text-sm hover:underline"
                    onClick={() => navigate('missions', m.id)}
                  >
                    <StatusBadge status={m.status} />
                    <span className="truncate">{m.request}</span>
                    <span className="ml-auto shrink-0 text-xs text-slate-500">{fmtDate(m.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Aucune mission pour l’instant.</Empty>
          )}
        </Card>
        <Card title="Activité récente" className="lg:col-span-2">
          <EventList events={events.data ?? []} />
        </Card>
      </div>
    </>
  );
}

import { useMemo, useState } from 'react';
import { KeyRound, PlugZap, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useAction, useResource } from '../hooks';
import type { Assignments, Catalog, ConnectionTest, MissionBudget, ProviderSettings, Role } from '../types';
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
  fmtDate,
  fmtUsd,
} from '../components/ui';
import { CONNECTION_LABEL } from './Dashboard';

interface ProviderState {
  hasKey: boolean;
  source: string | null;
  settings: ProviderSettings;
  lastTest: ConnectionTest | null;
  assignments: Assignments;
}

const ROLES: [Role, string][] = [
  ['primary', 'Principal (défaut)'],
  ['planning', 'Planification'],
  ['execution', 'Exécution (agents)'],
  ['verification', 'Vérification'],
];

export function ModelsPage() {
  const provider = useResource<ProviderState>('/api/provider', { live: false });
  const catalog = useResource<Catalog>('/api/provider/models', { live: false });
  const [key, setKey] = useState('');
  const saveKey = useAction(
    (apiKey: string) => api('/api/provider/key', { method: 'PUT', body: { apiKey } }),
    () => {
      setKey('');
      provider.reload();
    },
  );
  const deleteKey = useAction(() => api('/api/provider/key', { method: 'DELETE' }), provider.reload);
  const test = useAction(() => api<ConnectionTest>('/api/provider/test', { body: {} }), provider.reload);
  const refresh = useAction(() => api<Catalog>('/api/provider/models/refresh', { body: {} }), catalog.reload);
  const p = provider.data;
  const t = test.pending ? null : (p?.lastTest ?? null);

  return (
    <>
      <PageHeader
        title="Modèles et OpenRouter"
        subtitle="Tous les appels IA de HERMES passent par OpenRouter"
      />
      {provider.loading && !p && <Loading />}
      <ErrorBox error={provider.error?.message} />
      {p && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card title="Clé API">
            <p className="mb-2 text-sm">
              État :{' '}
              {p.hasKey ? (
                <Badge tone="success">
                  clé enregistrée ({p.source === 'env' ? 'variable d’environnement' : 'coffre du système'})
                </Badge>
              ) : (
                <Badge tone="warning">aucune clé</Badge>
              )}
            </p>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void saveKey.run(key);
              }}
            >
              <label htmlFor="api-key" className="sr-only">
                Clé API OpenRouter
              </label>
              <Input
                id="api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-or-…"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <Button
                type="submit"
                variant="primary"
                icon={<KeyRound className="size-4" />}
                pending={saveKey.pending}
                disabled={key.trim().length < 20}
              >
                Enregistrer
              </Button>
              {p.hasKey && p.source !== 'env' && (
                <Button
                  variant="danger"
                  icon={<Trash2 className="size-4" />}
                  pending={deleteKey.pending}
                  onClick={() => void deleteKey.run()}
                  aria-label="Supprimer la clé"
                >
                  Supprimer
                </Button>
              )}
            </form>
            <p className="mt-2 text-xs text-slate-500">
              La clé est stockée dans le Gestionnaire d’identification Windows. Elle n’est jamais renvoyée à
              l’interface ni écrite dans les journaux.
            </p>
            <ErrorBox error={saveKey.error ?? deleteKey.error} />
          </Card>

          <Card
            title="Test de connexion"
            actions={
              <Button
                variant="primary"
                icon={<PlugZap className="size-4" />}
                pending={test.pending}
                onClick={() => void test.run()}
              >
                Tester la connexion
              </Button>
            }
          >
            <p className="mb-2 text-xs text-slate-500">
              Effectue un véritable appel : vérification de la clé (/key) puis une complétion minimale avec le
              modèle principal.
            </p>
            {test.pending && <Loading label="Appel OpenRouter en cours…" />}
            {t ? (
              <div className="space-y-1 text-sm">
                <Badge tone={CONNECTION_LABEL[t.status]?.[1] ?? 'neutral'}>
                  {CONNECTION_LABEL[t.status]?.[0] ?? t.status}
                </Badge>
                <p>{t.message}</p>
                <p className="text-xs text-slate-500">
                  {fmtDate(t.testedAt)} · {t.latencyMs ?? '—'} ms · modèle {t.model ?? '—'}
                </p>
                {t.key && (
                  <p className="text-xs">
                    Consommation de la clé : {fmtUsd(t.key.usageUsd)}
                    {t.key.limitUsd != null
                      ? ` sur une limite de ${fmtUsd(t.key.limitUsd)} (reste ${fmtUsd(t.key.limitRemainingUsd)})`
                      : ' (pas de limite définie)'}
                    {t.key.isFreeTier ? ' · niveau gratuit' : ''}
                  </p>
                )}
              </div>
            ) : (
              !test.pending && <Empty>Jamais testé : l’état de connexion est inconnu.</Empty>
            )}
            <ErrorBox error={test.error} />
          </Card>

          <AssignmentsCard
            key={JSON.stringify(p.assignments)}
            assignments={p.assignments}
            catalog={catalog.data}
            onSaved={provider.reload}
          />
          <ProviderSettingsCard
            key={JSON.stringify(p.settings)}
            settings={p.settings}
            onSaved={provider.reload}
          />
          <BudgetCard />
          <CatalogCard
            catalog={catalog.data}
            loading={catalog.loading}
            error={catalog.error?.message ?? refresh.error}
            onRefresh={() => void refresh.run()}
            refreshing={refresh.pending}
          />
        </div>
      )}
    </>
  );
}

function AssignmentsCard({
  assignments,
  catalog,
  onSaved,
}: {
  assignments: Assignments;
  catalog: Catalog | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Record<Role, { modelId: string; fallbacks: string }>>(() =>
    toDraft(assignments),
  );
  const save = useAction(async () => {
    for (const [role] of ROLES) {
      const d = draft[role];
      if (!d.modelId.trim()) continue;
      await api(`/api/provider/assignments/${role}`, {
        method: 'PUT',
        body: {
          modelId: d.modelId.trim(),
          fallbacks: d.fallbacks
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
    }
  }, onSaved);
  const known = new Set(catalog?.models.map((m) => m.id));
  const warn = (id: string) => {
    if (!id || !catalog?.models.length) return null;
    const m = catalog.models.find((x) => x.id === id);
    if (!m) return 'absent du catalogue actualisé';
    if (!m.supportsTools) return 'n’annonce pas les appels d’outils (requis pour les agents)';
    return null;
  };
  return (
    <Card
      title="Modèles par rôle"
      actions={
        <Button variant="primary" pending={save.pending} onClick={() => void save.run()}>
          Enregistrer
        </Button>
      }
    >
      <datalist id="model-ids">
        {[...known].slice(0, 2000).map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>
      <div className="space-y-3">
        {ROLES.map(([role, label]) => (
          <div key={role} className="grid gap-2 sm:grid-cols-2">
            <Field
              id={`m-${role}`}
              label={label}
              hint={
                warn(draft[role].modelId) ? (
                  <span className="text-amber-600">⚠ {warn(draft[role].modelId)}</span>
                ) : role !== 'primary' ? (
                  'Vide = modèle principal'
                ) : undefined
              }
            >
              <Input
                id={`m-${role}`}
                list="model-ids"
                placeholder="fournisseur/modèle"
                value={draft[role].modelId}
                onChange={(e) => setDraft({ ...draft, [role]: { ...draft[role], modelId: e.target.value } })}
              />
            </Field>
            <Field
              id={`f-${role}`}
              label="Modèles de secours (virgules)"
              hint="Utilisés seulement si le modèle est indisponible"
            >
              <Input
                id={`f-${role}`}
                list="model-ids"
                value={draft[role].fallbacks}
                onChange={(e) =>
                  setDraft({ ...draft, [role]: { ...draft[role], fallbacks: e.target.value } })
                }
              />
            </Field>
          </div>
        ))}
      </div>
      <ErrorBox error={save.error} />
    </Card>
  );
}

function toDraft(a: Assignments) {
  return Object.fromEntries(
    ROLES.map(([r]) => [r, { modelId: a[r]?.modelId ?? '', fallbacks: a[r]?.fallbacks.join(', ') ?? '' }]),
  ) as Record<Role, { modelId: string; fallbacks: string }>;
}

function ProviderSettingsCard({ settings, onSaved }: { settings: ProviderSettings; onSaved: () => void }) {
  const [s, setS] = useState(settings);
  const save = useAction(() => api('/api/provider/settings', { method: 'PUT', body: s }), onSaved);
  const num = (k: keyof ProviderSettings, label: string, step = 1, hint?: string) => (
    <Field id={`ps-${k}`} label={label} hint={hint}>
      <Input
        id={`ps-${k}`}
        type="number"
        step={step}
        value={String(s[k])}
        onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })}
      />
    </Field>
  );
  return (
    <Card
      title="Paramètres du fournisseur"
      actions={
        <Button variant="primary" pending={save.pending} onClick={() => void save.run()}>
          Enregistrer
        </Button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          id="ps-base"
          label="URL de base"
          hint="Seul https://openrouter.ai/api/v1 est accepté (protection de la clé)."
        >
          <Input id="ps-base" value={s.baseUrl} onChange={(e) => setS({ ...s, baseUrl: e.target.value })} />
        </Field>
        {num('timeoutMs', 'Délai maximal (ms)', 1000)}
        {num('maxRetries', 'Tentatives (erreurs récupérables)')}
        {num('temperature', 'Température', 0.1, 'Envoyée seulement si le modèle la prend en charge')}
        {num('maxOutputTokens', 'Tokens de sortie max', 100)}
      </div>
      <ErrorBox error={save.error} />
    </Card>
  );
}

function BudgetCard() {
  const budget = useResource<MissionBudget>('/api/budget', { live: false });
  if (!budget.data)
    return (
      <Card title="Budget par mission">
        {budget.error ? <ErrorBox error={budget.error.message} /> : <Loading />}
      </Card>
    );
  // Remounted when the server copy changes, so the form always starts from saved values.
  return <BudgetForm key={JSON.stringify(budget.data)} initial={budget.data} onSaved={budget.reload} />;
}

function BudgetForm({ initial, onSaved }: { initial: MissionBudget; onSaved: () => void }) {
  const [b, setB] = useState(initial);
  const save = useAction(() => api('/api/budget', { method: 'PUT', body: b }), onSaved);
  const num = (k: keyof MissionBudget, label: string, step = 1) => (
    <Field id={`b-${k}`} label={label}>
      <Input
        id={`b-${k}`}
        type="number"
        step={step}
        value={String(b[k])}
        onChange={(e) => setB({ ...b, [k]: Number(e.target.value) })}
      />
    </Field>
  );
  return (
    <Card
      title="Budget par mission (défaut)"
      actions={
        <Button variant="primary" pending={save.pending} onClick={() => void save.run()}>
          Enregistrer
        </Button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {num('maxAiCalls', 'Appels IA max')}
        {num('maxCostUsd', 'Coût max (USD)', 0.1)}
        {num('maxDurationSec', 'Durée max (s)', 60)}
        {num('maxToolCalls', 'Appels d’outils max')}
        {num('maxParallelTasks', 'Tâches parallèles max')}
      </div>
      <ErrorBox error={save.error} />
    </Card>
  );
}

function CatalogCard({
  catalog,
  loading,
  error,
  onRefresh,
  refreshing,
}: {
  catalog: Catalog | null;
  loading: boolean;
  error: string | null | undefined;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [q, setQ] = useState('');
  const rows = useMemo(
    () =>
      (catalog?.models ?? []).filter((m) => !q || m.id.toLowerCase().includes(q.toLowerCase())).slice(0, 200),
    [catalog, q],
  );
  return (
    <Card
      className="xl:col-span-2"
      title={`Catalogue OpenRouter (${catalog?.models.length ?? 0} modèles)`}
      actions={
        <>
          <span className="text-xs text-slate-500">Actualisé : {fmtDate(catalog?.fetchedAt)}</span>
          <Button icon={<RefreshCw className="size-4" />} pending={refreshing} onClick={onRefresh}>
            Actualiser
          </Button>
        </>
      }
    >
      {loading && !catalog && <Loading />}
      <ErrorBox error={error ?? catalog?.error} title="Catalogue indisponible" />
      {catalog && catalog.models.length === 0 && !catalog.error && (
        <Empty>Catalogue jamais récupéré : cliquez sur « Actualiser ».</Empty>
      )}
      {catalog && catalog.models.length > 0 && (
        <>
          <label htmlFor="cat-q" className="sr-only">
            Filtrer les modèles
          </label>
          <Input
            id="cat-q"
            placeholder="Filtrer par identifiant…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="mb-2"
          />
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-white text-slate-500 dark:bg-slate-900">
                <tr>
                  <th className="py-1 pr-2">Identifiant</th>
                  <th className="pr-2">Fournisseur</th>
                  <th className="pr-2">Contexte</th>
                  <th className="pr-2">Entrée / sortie ($/M tokens)</th>
                  <th>Capacités déclarées</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1 pr-2">
                      <code>{m.id}</code>
                    </td>
                    <td className="pr-2">{m.provider}</td>
                    <td className="pr-2">{m.contextLength?.toLocaleString('fr-FR') ?? '—'}</td>
                    <td className="pr-2">
                      {m.pricing.promptPerMTok?.toFixed(2) ?? '—'} /{' '}
                      {m.pricing.completionPerMTok?.toFixed(2) ?? '—'}
                    </td>
                    <td className="space-x-1">
                      {m.supportsTools && <Badge tone="success">outils</Badge>}
                      {m.supportsStructuredOutputs && <Badge tone="info">JSON</Badge>}
                      {m.supportsImages && <Badge>images</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

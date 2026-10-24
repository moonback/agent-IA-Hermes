import { useMemo, useState } from 'react';
import { AudioLines, KeyRound, PlugZap, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useAction, useResource } from '../hooks';
import type {
  Assignments,
  Catalog,
  ConnectionTest,
  GeminiSettings,
  GeminiState,
  MissionBudget,
  ProviderSettings,
  Role,
  RoleProviders,
} from '../types';
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
  type Tone,
  fmtDate,
  fmtUsd,
} from '../components/ui';
import { CONNECTION_LABEL } from '../labels';

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
  ['voice', 'Voix (Gemini Live)'],
];

/** Gemini results never reuse OpenRouter's wording, so both cards stay distinguishable. */
const geminiLabel = (status: string): [string, Tone] =>
  status === 'ok' ? ['Test réussi', 'success'] : (CONNECTION_LABEL[status] ?? [status, 'neutral']);

export function ModelsPage() {
  const provider = useResource<ProviderState>('/api/provider', { live: false });
  const catalog = useResource<Catalog>('/api/provider/models', { live: false });
  const gemini = useResource<GeminiState>('/api/provider/gemini', { live: false });
  const geminiCatalog = useResource<Catalog>('/api/provider/gemini/models', { live: false });
  const roleProviders = useResource<RoleProviders>('/api/provider/role-providers', { live: false });
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
        subtitle="OpenRouter et Gemini : clés, modèle et fournisseur par rôle, tests de connexion réels"
      />
      {provider.loading && !p && <Loading />}
      <ErrorBox error={provider.error?.message} />
      {p && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card title="Clé API" icon={<KeyRound className="size-4" />}>
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
            <p className="mt-2 text-xs text-muted">
              La clé est stockée dans le Gestionnaire d’identification Windows. Elle n’est jamais renvoyée à
              l’interface ni écrite dans les journaux.
            </p>
            <ErrorBox error={saveKey.error ?? deleteKey.error} />
          </Card>

          <Card
            title="Test de connexion"
            icon={<PlugZap className="size-4" />}
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
            <p className="mb-2 text-xs text-muted">
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
                <p className="text-xs text-muted">
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

          {roleProviders.data && (
            <AssignmentsCard
              key={JSON.stringify([p.assignments, roleProviders.data])}
              assignments={p.assignments}
              providers={roleProviders.data}
              catalog={catalog.data}
              geminiCatalog={geminiCatalog.data}
              onSaved={() => {
                provider.reload();
                roleProviders.reload();
              }}
            />
          )}
          {gemini.data ? (
            <GeminiCard
              state={gemini.data}
              catalog={geminiCatalog.data}
              onChanged={gemini.reload}
              onCatalog={geminiCatalog.reload}
            />
          ) : (
            <ErrorBox error={gemini.error?.message} title="Gemini indisponible" />
          )}
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

type Draft = Record<Role, { modelId: string; fallbacks: string }>;

function AssignmentsCard({
  assignments,
  providers,
  catalog,
  geminiCatalog,
  onSaved,
}: {
  assignments: Assignments;
  providers: RoleProviders;
  catalog: Catalog | null;
  geminiCatalog: Catalog | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(assignments));
  const [kinds, setKinds] = useState<RoleProviders>(providers);
  const save = useAction(async () => {
    await api('/api/provider/role-providers', { method: 'PUT', body: kinds });
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
  const catalogOf = (role: Role) => (role === 'voice' || kinds[role] === 'gemini' ? geminiCatalog : catalog);
  const warn = (role: Role, id: string) => {
    const c = catalogOf(role);
    if (!id || !c?.models.length) return null;
    const m = c.models.find((x) => x.id === id);
    if (!m) return 'absent du catalogue actualisé';
    if (role === 'voice')
      return m.outputModalities.includes('audio') ? null : 'n’annonce pas la sortie audio (Live)';
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
        {(catalog?.models ?? []).slice(0, 2000).map((m) => (
          <option key={m.id} value={m.id} />
        ))}
      </datalist>
      <datalist id="gemini-model-ids">
        {(geminiCatalog?.models ?? []).map((m) => (
          <option key={m.id} value={m.id} />
        ))}
      </datalist>
      <div className="space-y-3">
        {ROLES.map(([role, label]) => {
          const geminiRole = role === 'voice' || kinds[role] === 'gemini';
          const w = warn(role, draft[role].modelId);
          return (
            <div key={role} className="grid gap-2 sm:grid-cols-[8.5rem_1fr_1fr]">
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted" aria-hidden>
                  Fournisseur
                </p>
                {role === 'voice' ? (
                  <p className="py-1.5">
                    <Badge tone="info" icon={<AudioLines className="size-3" aria-hidden />}>
                      Gemini Live
                    </Badge>
                  </p>
                ) : (
                  <Select
                    aria-label={`Fournisseur : ${role}`}
                    value={kinds[role]}
                    onChange={(e) =>
                      setKinds({ ...kinds, [role]: e.target.value as 'openrouter' | 'gemini' })
                    }
                  >
                    <option value="openrouter">OpenRouter</option>
                    <option value="gemini">Gemini</option>
                  </Select>
                )}
              </div>
              <Field
                id={`m-${role}`}
                label={label}
                hint={
                  w ? (
                    <span className="text-warning-fg">⚠ {w}</span>
                  ) : role === 'voice' ? (
                    'Vide = gemini-3.8-live'
                  ) : role !== 'primary' ? (
                    'Vide = modèle principal (et son fournisseur)'
                  ) : undefined
                }
              >
                <Input
                  id={`m-${role}`}
                  list={geminiRole ? 'gemini-model-ids' : 'model-ids'}
                  placeholder={
                    geminiRole ? (role === 'voice' ? 'gemini-3.8-live' : 'gemini-…') : 'fournisseur/modèle'
                  }
                  value={draft[role].modelId}
                  onChange={(e) =>
                    setDraft({ ...draft, [role]: { ...draft[role], modelId: e.target.value } })
                  }
                />
              </Field>
              {role === 'voice' ? (
                <p className="self-end pb-2 text-xs text-faint">
                  Pas de modèle de secours pour une session Live.
                </p>
              ) : (
                <Field
                  id={`f-${role}`}
                  label="Modèles de secours (virgules)"
                  hint="Utilisés seulement si le modèle est indisponible"
                >
                  <Input
                    id={`f-${role}`}
                    list={geminiRole ? 'gemini-model-ids' : 'model-ids'}
                    value={draft[role].fallbacks}
                    onChange={(e) =>
                      setDraft({ ...draft, [role]: { ...draft[role], fallbacks: e.target.value } })
                    }
                  />
                </Field>
              )}
            </div>
          );
        })}
      </div>
      <ErrorBox error={save.error} />
    </Card>
  );
}

function toDraft(a: Assignments): Draft {
  return Object.fromEntries(
    ROLES.map(([r]) => [r, { modelId: a[r]?.modelId ?? '', fallbacks: a[r]?.fallbacks.join(', ') ?? '' }]),
  ) as Draft;
}

function TestResult({ t, pending, label }: { t: ConnectionTest | null; pending: boolean; label: string }) {
  if (pending) return <Loading label={`${label} en cours…`} />;
  if (!t) return <p className="text-xs text-faint">{label} : jamais testé, état inconnu.</p>;
  const [text, tone] = geminiLabel(t.status);
  return (
    <div className="space-y-1 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">{label}</span>
        <Badge tone={tone}>{text}</Badge>
      </p>
      <p>{t.message}</p>
      <p className="text-xs text-faint">
        {fmtDate(t.testedAt)} · {t.latencyMs ?? '—'} ms · modèle {t.model ?? '—'}
      </p>
    </div>
  );
}

function GeminiCard({
  state,
  catalog,
  onChanged,
  onCatalog,
}: {
  state: GeminiState;
  catalog: Catalog | null;
  onChanged: () => void;
  onCatalog: () => void;
}) {
  const [key, setKey] = useState('');
  const [cfg, setCfg] = useState<GeminiSettings>(state.settings);
  const saveKey = useAction(
    (apiKey: string) => api('/api/provider/gemini/key', { method: 'PUT', body: { apiKey } }),
    () => {
      setKey('');
      onChanged();
    },
  );
  const deleteKey = useAction(() => api('/api/provider/gemini/key', { method: 'DELETE' }), onChanged);
  const saveCfg = useAction(
    () => api('/api/provider/gemini/settings', { method: 'PUT', body: cfg }),
    onChanged,
  );
  const test = useAction(() => api<ConnectionTest>('/api/provider/gemini/test', { body: {} }), onChanged);
  const testLive = useAction(
    () => api<ConnectionTest>('/api/provider/gemini/live-test', { body: {} }),
    onChanged,
  );
  const refresh = useAction(
    () => api<Catalog>('/api/provider/gemini/models/refresh', { body: {} }),
    onCatalog,
  );
  const dirty = JSON.stringify(cfg) !== JSON.stringify(state.settings);
  return (
    <Card title="Gemini (Google)" icon={<Sparkles className="size-4" />} className="xl:row-span-2">
      <div className="space-y-4">
        <section className="space-y-2">
          <p className="text-sm">
            État :{' '}
            {state.hasKey ? (
              <Badge tone="success">
                clé enregistrée ({state.source === 'env' ? 'variable d’environnement' : 'coffre du système'})
              </Badge>
            ) : (
              <Badge tone="warning">aucune clé Gemini</Badge>
            )}
          </p>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void saveKey.run(key);
            }}
          >
            <label htmlFor="gemini-key" className="sr-only">
              Clé API Gemini
            </label>
            <Input
              id="gemini-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="AIza… (ou jeton OAuth ya29.… pour Vertex AI)"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="min-w-48 flex-1"
            />
            <Button
              type="submit"
              variant="primary"
              icon={<KeyRound className="size-4" />}
              pending={saveKey.pending}
              disabled={key.trim().length < 30}
            >
              Enregistrer la clé Gemini
            </Button>
            {state.hasKey && state.source !== 'env' && (
              <Button
                variant="danger"
                icon={<Trash2 className="size-4" />}
                pending={deleteKey.pending}
                onClick={() => void deleteKey.run()}
              >
                Supprimer la clé Gemini
              </Button>
            )}
          </form>
          <p className="text-xs text-faint">
            Stockée dans le Gestionnaire d’identification Windows (entrée GEMINI_API_KEY), envoyée uniquement
            en en-tête à googleapis.com, jamais renvoyée à l’interface.
          </p>
          <ErrorBox error={saveKey.error ?? deleteKey.error} />
        </section>

        <section className="space-y-2 border-t border-line pt-3">
          <Field id="gemini-backend" label="Point d’accès">
            <Select
              id="gemini-backend"
              value={cfg.backend}
              onChange={(e) => setCfg({ ...cfg, backend: e.target.value as GeminiSettings['backend'] })}
            >
              <option value="ai-studio">Google AI Studio (generativelanguage.googleapis.com)</option>
              <option value="vertex">Vertex AI (quotas et SLA entreprise)</option>
            </Select>
          </Field>
          {cfg.backend === 'vertex' && (
            <div className="grid gap-2 sm:grid-cols-2">
              <Field id="gemini-project" label="Projet Google Cloud">
                <Input
                  id="gemini-project"
                  value={cfg.vertexProject}
                  placeholder="mon-projet"
                  onChange={(e) => setCfg({ ...cfg, vertexProject: e.target.value.trim() })}
                />
              </Field>
              <Field id="gemini-location" label="Région Vertex AI">
                <Input
                  id="gemini-location"
                  value={cfg.vertexLocation}
                  placeholder="europe-west4 ou global"
                  onChange={(e) => setCfg({ ...cfg, vertexLocation: e.target.value.trim() })}
                />
              </Field>
            </div>
          )}
          <Button disabled={!dirty} pending={saveCfg.pending} onClick={() => void saveCfg.run()}>
            Appliquer le point d’accès
          </Button>
          <ErrorBox error={saveCfg.error} />
        </section>

        <section className="space-y-3 border-t border-line pt-3">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              icon={<PlugZap className="size-4" />}
              pending={test.pending}
              disabled={!state.hasKey}
              onClick={() => void test.run()}
            >
              Tester Gemini
            </Button>
            <Button
              icon={<AudioLines className="size-4" />}
              pending={testLive.pending}
              disabled={!state.hasKey}
              onClick={() => void testLive.run()}
            >
              Tester Gemini Live
            </Button>
          </div>
          <p className="text-xs text-faint">
            Appels réels : catalogue puis génération minimale avec le premier rôle routé vers Gemini ;
            ouverture puis fermeture d’une session Live avec le modèle du rôle « voice ».
          </p>
          <TestResult t={test.pending ? null : state.lastTest} pending={test.pending} label="Complétion" />
          <TestResult
            t={testLive.pending ? null : state.liveTest}
            pending={testLive.pending}
            label="Session Live"
          />
          <ErrorBox error={test.error ?? testLive.error} />
        </section>

        <section className="space-y-2 border-t border-line pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">
              Catalogue Gemini : <b>{catalog?.models.length ?? 0}</b> modèle(s){' '}
              <span className="text-xs text-faint">· {fmtDate(catalog?.fetchedAt)}</span>
            </p>
            <Button
              icon={<RefreshCw className="size-4" />}
              pending={refresh.pending}
              disabled={!state.hasKey}
              onClick={() => void refresh.run()}
            >
              Rafraîchir le catalogue Gemini
            </Button>
          </div>
          <ErrorBox error={refresh.error ?? catalog?.error} title="Catalogue Gemini indisponible" />
          <p className="text-xs text-faint">
            Google ne publie pas les prix par l’API : le coût Gemini reste « inconnu ».
          </p>
        </section>
      </div>
    </Card>
  );
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
          <span className="text-xs text-muted">Actualisé : {fmtDate(catalog?.fetchedAt)}</span>
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
              <thead className="sticky top-0 z-10 bg-solid text-faint">
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
                  <tr key={m.id} className="border-t border-line transition-colors hover:bg-raised">
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

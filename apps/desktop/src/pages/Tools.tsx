import { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Box,
  FileLock2,
  KeyRound,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { api } from '../api';
import { useAction, useResource } from '../hooks';
import type { MissionEvent, Policy, ToolInfo } from '../types';
import { EventList } from '../components/shared';
import {
  Badge,
  Button,
  Card,
  DataList,
  ErrorBox,
  Field,
  Input,
  Loading,
  PageHeader,
  Select,
  Switch,
  fmtDate,
} from '../components/ui';

import { RISK_LABEL, RISK_TONE } from '../labels';

export function ToolsPage() {
  const policy = useResource<Policy>('/api/policy', { live: false });
  const tools = useResource<ToolInfo[]>('/api/tools', { live: false });
  // Local edits override the server copy until saved; null means "no pending edit".
  const [edits, setDraft] = useState<Policy | null>(null);
  const draft = edits ?? policy.data;
  const save = useAction(
    (p: Policy) => api<Policy>('/api/policy', { method: 'PUT', body: p }),
    () => {
      setDraft(null);
      policy.reload();
      tools.reload();
    },
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(policy.data);

  return (
    <>
      <PageHeader
        title="Outils et permissions"
        subtitle="Politique appliquée par le code, indépendamment du modèle et du contenu des pages ou fichiers"
        actions={
          <Button
            variant="primary"
            icon={<ShieldCheck className="size-4" />}
            disabled={!dirty || !draft}
            pending={save.pending}
            onClick={() => draft && void save.run(draft)}
          >
            Enregistrer la politique
          </Button>
        }
      />
      <ErrorBox error={save.error ?? policy.error?.message} />
      {!draft ? (
        <Loading />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <ListEditor
            title="Dossiers autorisés"
            hint="Chemins absolus. Tout chemin hors de ces dossiers est refusé (liens et jonctions résolus)."
            values={draft.allowedRoots}
            placeholder="C:\Users\vous\Documents\HERMES"
            onChange={(allowedRoots) => setDraft({ ...draft, allowedRoots })}
          />
          <Card title="Domaines Web autorisés">
            <ListEditor
              bare
              title=""
              values={draft.allowedDomains}
              placeholder="example.com"
              onChange={(allowedDomains) => setDraft({ ...draft, allowedDomains })}
            />
            <div className="mt-4 border-t border-line pt-3">
              <Field
                id="unknown-domains"
                label="Domaine non listé"
                hint="« Demander » crée une approbation pour cet accès précis."
              >
                <Select
                  id="unknown-domains"
                  value={draft.unknownDomains}
                  onChange={(e) =>
                    setDraft({ ...draft, unknownDomains: e.target.value as Policy['unknownDomains'] })
                  }
                >
                  <option value="ask">Demander une approbation</option>
                  <option value="deny">Refuser</option>
                </Select>
              </Field>
            </div>
          </Card>
          <ListEditor
            title="Commandes autorisées (process.run)"
            hint="Noms d’exécutables lancés sans shell. Les commandes hors lecture seule demandent une approbation."
            values={draft.allowedCommands}
            placeholder="git"
            onChange={(allowedCommands) => setDraft({ ...draft, allowedCommands })}
          />
          <ListEditor
            title="Applications bureau autorisées"
            hint="Noms de processus (ex. notepad). Les autres applications demandent une approbation par action."
            values={draft.allowedApps}
            placeholder="notepad"
            onChange={(allowedApps) => setDraft({ ...draft, allowedApps })}
          />
          <SearchCard onChange={tools.reload} />
          <SandboxCard />
        </div>
      )}

      <Card title="Catalogue des outils" icon={<Wrench className="size-4" />} className="mt-4">
        {tools.loading && !tools.data && <Loading />}
        <ErrorBox error={tools.error?.message} />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-faint">
              <tr>
                <th className="py-1 pr-2">Outil</th>
                <th className="pr-2">Disponibilité</th>
                <th className="pr-2">Risque</th>
                <th className="pr-2">Permissions</th>
                <th className="pr-2">Agents</th>
                <th className="pr-2">Approbation</th>
                <th className="pr-2">Activé</th>
                <th>Usage</th>
              </tr>
            </thead>
            <tbody>
              {tools.data?.map((t) => (
                <tr key={t.id} className="border-t border-line align-top transition-colors hover:bg-raised">
                  <td className="py-1.5 pr-2">
                    <code className="text-xs font-semibold">{t.id}</code>
                    <details>
                      <summary className="cursor-pointer text-xs text-muted">détails</summary>
                      <p className="text-xs">{t.description}</p>
                      <p className="text-xs text-muted">Vérification : {t.verification}</p>
                      <p className="text-xs text-muted">Confirmation : {t.confirmation}</p>
                      <p className="text-xs text-muted">
                        {t.reversible ? 'Réversible' : 'Irréversible'} ·{' '}
                        {t.idempotent ? 'idempotent' : 'protégé contre les doublons'} · délai{' '}
                        {t.timeoutMs / 1000} s
                      </p>
                    </details>
                  </td>
                  <td className="pr-2">
                    <Badge
                      tone={t.availability.available ? 'success' : 'warning'}
                      title={t.availability.reason}
                    >
                      {t.availability.available ? 'disponible' : 'indisponible'}
                    </Badge>
                    {t.availability.reason && (
                      <p className="max-w-56 text-xs text-muted">{t.availability.reason}</p>
                    )}
                  </td>
                  <td className="pr-2">
                    <Badge tone={RISK_TONE[t.risk]}>{RISK_LABEL[t.risk]}</Badge>
                  </td>
                  <td className="pr-2 text-xs">{t.permissions.join(', ')}</td>
                  <td className="pr-2 text-xs">{t.allowedAgents.join(', ')}</td>
                  <td className="pr-2">
                    {draft && (
                      <Select
                        aria-label={`Règle d’approbation pour ${t.id}`}
                        className="w-36 text-xs"
                        value={draft.approvalRules[t.id] ?? 'auto'}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            approvalRules: {
                              ...draft.approvalRules,
                              [t.id]: e.target.value as 'always' | 'auto' | 'never',
                            },
                          })
                        }
                      >
                        <option value="auto">Selon le risque</option>
                        <option value="always">Toujours</option>
                        <option value="never">Jamais (sauf ressource non autorisée)</option>
                      </Select>
                    )}
                  </td>
                  <td className="pr-2">
                    {draft && (
                      <input
                        type="checkbox"
                        aria-label={`Activer ${t.id}`}
                        checked={!draft.disabledTools.includes(t.id)}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            disabledTools: e.target.checked
                              ? draft.disabledTools.filter((x) => x !== t.id)
                              : [...draft.disabledTools, t.id],
                          })
                        }
                      />
                    )}
                  </td>
                  <td className="text-xs">
                    {t.stats
                      ? `${t.stats.calls} appels, ${t.stats.failures} refus/échecs${t.stats.avgMs != null ? `, ${Math.round(t.stats.avgMs)} ms moy.` : ''}`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <AuditCard />
    </>
  );
}

function ListEditor({
  title,
  hint,
  values,
  placeholder,
  onChange,
  bare,
}: {
  title: string;
  hint?: string;
  values: string[];
  placeholder: string;
  onChange: (v: string[]) => void;
  bare?: boolean;
}) {
  const [v, setV] = useState('');
  const body = (
    <div className="space-y-2">
      <ul className="space-y-1">
        {values.map((x) => (
          <li key={x} className="flex items-center gap-2 text-sm">
            <code className="min-w-0 flex-1 truncate" title={x}>
              {x}
            </code>
            <Button
              variant="ghost"
              aria-label={`Retirer ${x}`}
              icon={<X className="size-4" />}
              onClick={() => onChange(values.filter((y) => y !== x))}
            />
          </li>
        ))}
        {values.length === 0 && <li className="text-sm text-muted">Aucun élément.</li>}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (v.trim() && !values.includes(v.trim())) onChange([...values, v.trim()]);
          setV('');
        }}
      >
        <Input
          aria-label={`Ajouter à ${title || 'la liste'}`}
          placeholder={placeholder}
          value={v}
          onChange={(e) => setV(e.target.value)}
        />
        <Button type="submit" icon={<Plus className="size-4" />}>
          Ajouter
        </Button>
      </form>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
  return bare ? body : <Card title={title}>{body}</Card>;
}

function AuditCard() {
  const [category, setCategory] = useState('security');
  const events = useResource<MissionEvent[]>(
    `/api/events?limit=150${category ? `&category=${category}` : ''}`,
  );
  const verify = useAction(() =>
    api<{ ok: boolean; checked: number; brokenAtSeq: number | null; purgedGaps: number }>(
      '/api/audit/verify',
    ),
  );
  const [result, setResult] = useState<string | null>(null);
  return (
    <Card
      className="mt-4"
      title="Journal d’audit"
      icon={<FileLock2 className="size-4" />}
      actions={
        <>
          <Select
            aria-label="Catégorie"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-40"
          >
            {[
              '',
              'security',
              'orchestration',
              'tools',
              'provider',
              'browser',
              'desktop',
              'persistence',
              'scheduler',
              'voice',
              'application',
            ].map((c) => (
              <option key={c} value={c}>
                {c || 'toutes'}
              </option>
            ))}
          </Select>
          <Button
            pending={verify.pending}
            onClick={() =>
              void verify
                .run()
                .then(
                  (r) =>
                    r &&
                    setResult(
                      r.ok
                        ? `Chaîne intègre : ${r.checked} événements vérifiés${r.purgedGaps ? ` (${r.purgedGaps} coupure(s) dues à une purge explicite)` : ''}`
                        : `Chaîne ROMPUE à l’événement n° ${r.brokenAtSeq}`,
                    ),
                )
            }
          >
            Vérifier l’intégrité
          </Button>
        </>
      }
    >
      {result && <p className="mb-2 text-sm font-medium">{result}</p>}
      <ErrorBox error={verify.error ?? events.error?.message} />
      <EventList events={events.data ?? []} />
    </Card>
  );
}

// ------------------------------------------------------------------ web search providers

type SearchId = 'tavily' | 'brave' | 'openrouter-web';
interface SearchState {
  settings: { provider: 'auto' | 'none' | SearchId; order: SearchId[] };
  providers: { id: SearchId; available: boolean; reason: string | null; cooldownUntil: string | null }[];
  keys: { tavily: boolean; brave: boolean };
}
const SEARCH_LABEL: Record<SearchId, string> = {
  tavily: 'Tavily',
  brave: 'Brave Search',
  'openrouter-web': 'OpenRouter Web',
};
const SEARCH_HINT: Record<SearchId, string> = {
  tavily: 'API conçue pour les agents ; renvoie sources et une réponse rédigée par Tavily.',
  brave: 'Index Web indépendant ; résultats bruts, sans synthèse.',
  'openrouter-web': 'Plugin web d’OpenRouter avec le modèle principal (facturé par requête).',
};

function SearchCard({ onChange }: { onChange: () => void }) {
  const state = useResource<SearchState>('/api/search-providers', { live: false });
  const done = () => {
    state.reload();
    onChange();
  };
  const saveSettings = useAction(
    (s: SearchState['settings']) => api('/api/search-settings', { method: 'PUT', body: s }),
    done,
  );
  const [keys, setKeys] = useState<Record<string, string>>({});
  const saveKey = useAction(
    (id: 'tavily' | 'brave') =>
      api(`/api/search-providers/${id}/key`, { method: 'PUT', body: { apiKey: keys[id] ?? '' } }),
    () => {
      setKeys({});
      done();
    },
  );
  const deleteKey = useAction(
    (id: 'tavily' | 'brave') => api(`/api/search-providers/${id}/key`, { method: 'DELETE' }),
    done,
  );
  const s = state.data?.settings;
  const move = (i: number, d: -1 | 1) => {
    if (!s) return;
    const order = [...s.order];
    [order[i], order[i + d]] = [order[i + d]!, order[i]!];
    void saveSettings.run({ ...s, order });
  };
  return (
    <Card title="Recherche Web" icon={<Search className="size-4" />}>
      {!s && <Loading />}
      {s && (
        <div className="space-y-3">
          <Field
            id="search-provider"
            label="Fournisseur"
            hint="« Automatique » essaie dans l’ordre les fournisseurs configurés et passe au suivant en cas de quota ou de limite de débit. Aucune recherche n’est simulée."
          >
            <Select
              id="search-provider"
              value={s.provider}
              disabled={saveSettings.pending}
              onChange={(e) =>
                void saveSettings.run({
                  ...s,
                  provider: e.target.value as SearchState['settings']['provider'],
                })
              }
            >
              <option value="none">Aucun (recherche indisponible)</option>
              <option value="auto">Automatique (ordre ci-dessous)</option>
              <option value="tavily">Tavily</option>
              <option value="brave">Brave Search</option>
              <option value="openrouter-web">OpenRouter Web</option>
            </Select>
          </Field>
          <ol className="space-y-2">
            {s.order.map((id, i) => {
              const st = state.data?.providers.find((p) => p.id === id);
              const keyed = id === 'tavily' || id === 'brave';
              return (
                <li key={id} className="rounded-control p-2 ring-1 ring-line ring-inset">
                  <div className="flex flex-wrap items-center gap-2">
                    {s.provider === 'auto' && <span className="text-xs text-faint">{i + 1}.</span>}
                    <span className="font-medium">{SEARCH_LABEL[id]}</span>
                    <Badge tone={st?.available ? 'success' : 'warning'}>
                      {st?.available ? 'disponible' : (st?.reason ?? 'indisponible')}
                    </Badge>
                    {s.provider === 'auto' && (
                      <span className="ml-auto flex gap-1">
                        <Button
                          variant="ghost"
                          aria-label={`Monter ${SEARCH_LABEL[id]}`}
                          icon={<ArrowUp className="size-4" />}
                          disabled={i === 0}
                          onClick={() => move(i, -1)}
                        />
                        <Button
                          variant="ghost"
                          aria-label={`Descendre ${SEARCH_LABEL[id]}`}
                          icon={<ArrowDown className="size-4" />}
                          disabled={i === s.order.length - 1}
                          onClick={() => move(i, 1)}
                        />
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted">{SEARCH_HINT[id]}</p>
                  {st?.cooldownUntil && (
                    <p className="text-xs text-warning-fg">En pause jusqu’au {fmtDate(st.cooldownUntil)}</p>
                  )}
                  {keyed && (
                    <form
                      className="mt-2 flex flex-wrap gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveKey.run(id);
                      }}
                    >
                      <Input
                        type="password"
                        autoComplete="off"
                        aria-label={`Clé API ${SEARCH_LABEL[id]}`}
                        placeholder={
                          state.data?.keys[id] ? 'Clé enregistrée — saisir pour remplacer' : 'Clé API'
                        }
                        value={keys[id] ?? ''}
                        onChange={(e) => setKeys({ ...keys, [id]: e.target.value })}
                        className="w-56 flex-1"
                      />
                      <Button type="submit" icon={<KeyRound className="size-4" />} disabled={!keys[id]}>
                        Enregistrer
                      </Button>
                      {state.data?.keys[id] && (
                        <Button
                          variant="ghost"
                          aria-label={`Supprimer la clé ${SEARCH_LABEL[id]}`}
                          icon={<Trash2 className="size-4" />}
                          onClick={() => void deleteKey.run(id)}
                        />
                      )}
                    </form>
                  )}
                </li>
              );
            })}
          </ol>
          <p className="text-xs text-faint">
            Les clés sont stockées dans le coffre du système ; elles ne sont jamais renvoyées à l’interface.
          </p>
        </div>
      )}
      <ErrorBox error={state.error?.message ?? saveSettings.error ?? saveKey.error ?? deleteKey.error} />
    </Card>
  );
}

// ------------------------------------------------------------------ process sandbox

interface SandboxState {
  settings: { enabled: boolean; memoryMb: number; cpuPercent: number; maxProcesses: number };
  runner: string | null;
  active: boolean;
  reason: string | null;
}

function SandboxCard() {
  const state = useResource<SandboxState>('/api/sandbox', { live: false });
  const [edit, setEdit] = useState<SandboxState['settings'] | null>(null);
  const draft = edit ?? state.data?.settings ?? null;
  const save = useAction(
    (s: SandboxState['settings']) => api('/api/sandbox', { method: 'PUT', body: s }),
    () => {
      setEdit(null);
      state.reload();
    },
  );
  const num = (k: 'memoryMb' | 'cpuPercent' | 'maxProcesses', v: string) =>
    draft && setEdit({ ...draft, [k]: Number(v) });
  return (
    <Card title="Bac à sable des processus" icon={<Box className="size-4" />}>
      {!draft && <Loading />}
      {draft && state.data && (
        <div className="space-y-3">
          <DataList
            rows={[
              [
                'État',
                <Badge key="s" tone={state.data.active ? 'success' : 'warning'}>
                  {state.data.active ? 'Job Object actif' : `Inactif — ${state.data.reason}`}
                </Badge>,
              ],
              ['Utilitaire', state.data.runner ?? '—'],
            ]}
          />
          <Switch
            id="sandbox-enabled"
            label="Isoler process.run et shell.pipe (Windows Job Object)"
            description="Limites de mémoire, de CPU et de nombre de processus ; toute l’arborescence est arrêtée à la fin ou à l’expiration du délai."
            checked={draft.enabled}
            onChange={(enabled) => setEdit({ ...draft, enabled })}
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field id="sb-mem" label="Mémoire (Mo)">
              <Input
                id="sb-mem"
                type="number"
                min={64}
                value={draft.memoryMb}
                onChange={(e) => num('memoryMb', e.target.value)}
              />
            </Field>
            <Field id="sb-cpu" label="CPU max. (%)">
              <Input
                id="sb-cpu"
                type="number"
                min={5}
                max={100}
                value={draft.cpuPercent}
                onChange={(e) => num('cpuPercent', e.target.value)}
              />
            </Field>
            <Field id="sb-proc" label="Processus max.">
              <Input
                id="sb-proc"
                type="number"
                min={1}
                value={draft.maxProcesses}
                onChange={(e) => num('maxProcesses', e.target.value)}
              />
            </Field>
          </div>
          <Button
            variant="primary"
            disabled={!edit}
            pending={save.pending}
            onClick={() => edit && void save.run(edit)}
          >
            Enregistrer
          </Button>
        </div>
      )}
      <ErrorBox error={state.error?.message ?? save.error} />
    </Card>
  );
}

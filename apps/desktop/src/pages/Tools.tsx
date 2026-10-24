import { useState } from 'react';
import { Plus, ShieldCheck, X } from 'lucide-react';
import { api } from '../api';
import { useAction, useResource } from '../hooks';
import type { MissionEvent, Policy, ToolInfo } from '../types';
import { EventList } from '../components/shared';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Select } from '../components/ui';

const RISK_TONE = { low: 'success', medium: 'warning', high: 'danger' } as const;

export function ToolsPage() {
  const policy = useResource<Policy>('/api/policy', { live: false });
  const tools = useResource<ToolInfo[]>('/api/tools', { live: false });
  const search = useResource<{ provider: 'none' | 'openrouter-web' }>('/api/search-settings', {
    live: false,
  });
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
  const saveSearch = useAction(
    (provider: string) => api('/api/search-settings', { method: 'PUT', body: { provider } }),
    () => {
      search.reload();
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
          <Card title="Recherche Web">
            <Field
              id="search-provider"
              label="Fournisseur"
              hint="« OpenRouter Web » utilise le plugin web d’OpenRouter (facturé par requête). Aucune recherche n’est simulée."
            >
              <Select
                id="search-provider"
                value={search.data?.provider ?? 'none'}
                onChange={(e) => void saveSearch.run(e.target.value)}
                disabled={saveSearch.pending}
              >
                <option value="none">Aucun (recherche indisponible)</option>
                <option value="openrouter-web">OpenRouter Web</option>
              </Select>
            </Field>
            <ErrorBox error={saveSearch.error} />
          </Card>
        </div>
      )}

      <Card title="Catalogue des outils" className="mt-4">
        {tools.loading && !tools.data && <Loading />}
        <ErrorBox error={tools.error?.message} />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-500">
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
                <tr key={t.id} className="border-t border-slate-100 align-top dark:border-slate-800">
                  <td className="py-1.5 pr-2">
                    <code className="text-xs font-semibold">{t.id}</code>
                    <details>
                      <summary className="cursor-pointer text-xs text-slate-500">détails</summary>
                      <p className="text-xs">{t.description}</p>
                      <p className="text-xs text-slate-500">Vérification : {t.verification}</p>
                      <p className="text-xs text-slate-500">Confirmation : {t.confirmation}</p>
                      <p className="text-xs text-slate-500">
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
                      <p className="max-w-56 text-xs text-slate-500">{t.availability.reason}</p>
                    )}
                  </td>
                  <td className="pr-2">
                    <Badge tone={RISK_TONE[t.risk]}>{t.risk}</Badge>
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
        {values.length === 0 && <li className="text-sm text-slate-500">Aucun élément.</li>}
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
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
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

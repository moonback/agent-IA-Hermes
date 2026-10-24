import { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  CalendarDays,
  History,
  Pencil,
  Play,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api';
import { useAction, useResource } from '../hooks';
import { useApp } from '../store';
import type { ProactiveSettings, ScheduledTrigger, TriggerRun, TriggerSpec, TriggersState } from '../types';
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
  StatusBadge,
  Switch,
  Textarea,
  fmtDate,
  fmtUsd,
} from '../components/ui';

const KIND_LABEL: Record<TriggerSpec['kind'], string> = {
  cron: 'Planifié (cron)',
  interval: 'Intervalle',
  event: 'Fichier',
  condition: 'Après un échec',
};

const CRON_PRESETS: [string, string][] = [
  ['0 8 * * *', 'Tous les jours à 8 h'],
  ['30 9 * * mon-fri', 'Jours ouvrés à 9 h 30'],
  ['0 */2 * * *', 'Toutes les 2 heures'],
  ['0 18 * * fri', 'Le vendredi à 18 h'],
  ['0 7 1 * *', 'Le 1er du mois à 7 h'],
];

export function SchedulePage() {
  const state = useResource<TriggersState>('/api/triggers', { intervalMs: 30_000 });
  const [editing, setEditing] = useState<ScheduledTrigger | 'new' | null>(null);
  const s = state.data?.status;
  return (
    <>
      <PageHeader
        title="Planification"
        subtitle="Missions proactives déclenchées par une heure, un fichier ou l’échec d’une mission — toujours planifiées, contrôlées et soumises aux approbations"
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            Nouveau déclencheur
          </Button>
        }
      />
      {state.loading && !state.data && <Loading />}
      <ErrorBox error={state.error?.message} />
      {s && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={s.settings.enabled && s.running ? 'success' : 'warning'}>
            {s.settings.enabled
              ? s.running
                ? 'Planificateur actif'
                : 'Planificateur arrêté'
              : 'Missions proactives désactivées'}
          </Badge>
          <Badge tone="info">Budget max. {s.settings.maxCostUsd.toFixed(2)} $ / mission</Badge>
          <Badge>
            {s.launchedLast24h} / {s.settings.maxRunsPerDay} missions sur 24 h
          </Badge>
          {s.watching > 0 && <Badge>{s.watching} dossier(s) surveillé(s)</Badge>}
        </div>
      )}
      {editing && state.data && (
        <TriggerForm
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          triggers={state.data.triggers}
          variables={state.data.variables}
          cap={state.data.status.settings.maxCostUsd}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            state.reload();
          }}
        />
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <TriggerList state={state.data} onEdit={setEditing} reload={state.reload} />
        <div className="space-y-4">
          <Calendar triggers={state.data?.triggers ?? []} />
          {state.data && <PolicyCard settings={state.data.status.settings} onSaved={state.reload} />}
        </div>
      </div>
      <RunHistory triggers={state.data?.triggers ?? []} />
    </>
  );
}

// ------------------------------------------------------------------ list

function TriggerList({
  state,
  onEdit,
  reload,
}: {
  state: TriggersState | null;
  onEdit: (t: ScheduledTrigger) => void;
  reload: () => void;
}) {
  const navigate = useApp((s) => s.navigate);
  const toggle = useAction(
    (t: ScheduledTrigger) => api(`/api/triggers/${t.id}`, { method: 'PATCH', body: { enabled: !t.enabled } }),
    reload,
  );
  const runNow = useAction(
    (t: ScheduledTrigger) => api<TriggerRun>(`/api/triggers/${t.id}/run`, { body: {} }),
    reload,
  );
  const remove = useAction(
    (t: ScheduledTrigger) => api(`/api/triggers/${t.id}`, { method: 'DELETE' }),
    reload,
  );
  const triggers = state?.triggers ?? [];
  return (
    <Card title="Déclencheurs" icon={<CalendarClock className="size-4" />}>
      <ErrorBox error={toggle.error ?? runNow.error ?? remove.error} />
      {state && triggers.length === 0 && (
        <Empty>
          Aucun déclencheur. Exemple : « Tous les matins à 8 h, résume les actualités tech et enregistre-les
          en mémoire ».
        </Empty>
      )}
      <ul className="space-y-2">
        {triggers.map((t) => (
          <li key={t.id} className="rounded-control p-3 ring-1 ring-line ring-inset">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {t.name}
                  <Badge tone="info">{KIND_LABEL[t.kind]}</Badge>
                  {!t.enabled && <Badge tone="warning">désactivé</Badge>}
                  {!t.autoStart && <Badge>validation manuelle</Badge>}
                </p>
                <p className="text-xs text-muted">{t.description}</p>
                <p className="mt-1 line-clamp-2 text-sm">{t.missionTemplate}</p>
                <p className="mt-1 text-xs text-faint">
                  {t.nextRunAt && t.enabled ? `Prochaine exécution : ${fmtDate(t.nextRunAt)} · ` : ''}
                  {t.runCount} mission(s) lancée(s)
                  {t.lastRunAt ? ` · dernière : ${fmtDate(t.lastRunAt)}` : ''}
                  {t.budget.maxCostUsd !== undefined ? ` · budget ${t.budget.maxCostUsd.toFixed(2)} $` : ''}
                </p>
                {t.lastError && (
                  <p className="mt-1 text-xs text-danger-fg">Dernière erreur : {t.lastError}</p>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                <Switch
                  id={`trg-${t.id}`}
                  label={t.enabled ? 'Actif' : 'Inactif'}
                  checked={t.enabled}
                  onChange={() => void toggle.run(t)}
                />
                <Button
                  variant="ghost"
                  aria-label={`Exécuter « ${t.name} » maintenant`}
                  title="Exécuter maintenant"
                  icon={<Play className="size-4" />}
                  pending={runNow.pending}
                  onClick={() => void runNow.run(t)}
                />
                <Button
                  variant="ghost"
                  aria-label={`Modifier « ${t.name} »`}
                  icon={<Pencil className="size-4" />}
                  onClick={() => onEdit(t)}
                />
                <Button
                  variant="ghost"
                  aria-label={`Supprimer « ${t.name} »`}
                  icon={<Trash2 className="size-4" />}
                  onClick={() => {
                    if (window.confirm(`Supprimer le déclencheur « ${t.name} » et son historique ?`))
                      void remove.run(t);
                  }}
                />
              </div>
            </div>
            {t.lastMissionId && (
              <button
                type="button"
                className="mt-1 text-xs text-accent-fg hover:underline"
                onClick={() => navigate('missions', t.lastMissionId)}
              >
                Voir la dernière mission
              </button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ------------------------------------------------------------------ calendar

function Calendar({ triggers }: { triggers: ScheduledTrigger[] }) {
  const days = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const end = new Date(d);
      end.setDate(end.getDate() + 1);
      const runs = triggers
        .flatMap((t) => t.upcoming.map((at) => ({ at, name: t.name, id: t.id })))
        .filter((r) => {
          const ms = Date.parse(r.at);
          return ms >= Math.max(d.getTime(), Date.now()) && ms < end.getTime();
        })
        .sort((a, b) => a.at.localeCompare(b.at));
      return { d, runs };
    });
  }, [triggers]);
  const reactive = triggers.filter((t) => t.enabled && (t.kind === 'event' || t.kind === 'condition'));
  return (
    <Card title="7 prochains jours" icon={<CalendarDays className="size-4" />}>
      <ol className="space-y-2">
        {days.map(({ d, runs }) => (
          <li key={d.toISOString()} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 text-sm">
            <span className="text-xs font-medium text-muted capitalize">
              {d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })}
            </span>
            <span className="flex flex-wrap gap-1">
              {runs.length === 0 && <span className="text-xs text-faint">—</span>}
              {runs.slice(0, 8).map((r) => (
                <Badge key={`${r.id}-${r.at}`} tone="info" title={fmtDate(r.at)}>
                  {new Date(r.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}{' '}
                  {r.name}
                </Badge>
              ))}
              {runs.length > 8 && <Badge>+{runs.length - 8}</Badge>}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-faint">
        Seules les 10 prochaines occurrences de chaque déclencheur sont affichées.
        {reactive.length > 0 &&
          ` ${reactive.length} déclencheur(s) réagissent à un événement (hors calendrier).`}
      </p>
    </Card>
  );
}

// ------------------------------------------------------------------ policy

function PolicyCard({ settings, onSaved }: { settings: ProactiveSettings; onSaved: () => void }) {
  // Local edits override the server copy until saved; null means "no pending edit".
  const [edit, setP] = useState<ProactiveSettings | null>(null);
  const p = edit ?? settings;
  const save = useAction(
    () => api('/api/proactive-settings', { method: 'PUT', body: p }),
    () => {
      setP(null);
      onSaved();
    },
  );
  const dirty = JSON.stringify(p) !== JSON.stringify(settings);
  return (
    <Card title="Politique des missions proactives" icon={<ShieldCheck className="size-4" />}>
      <div className="space-y-3">
        <Switch
          id="proactive-enabled"
          label="Autoriser les missions proactives"
          description="Désactivé : les déclencheurs restent enregistrés, rien n’est lancé."
          checked={p.enabled}
          onChange={(enabled) => setP({ ...p, enabled })}
        />
        <Switch
          id="proactive-toast"
          label="Notifications Windows"
          description="Au démarrage et à la fin de chaque mission proactive (les notifications dans l’application sont toujours affichées)."
          checked={p.desktopNotifications}
          onChange={(desktopNotifications) => setP({ ...p, desktopNotifications })}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="proactive-cap"
            label="Coût max. par mission (USD)"
            hint="Plafond appliqué à tout déclencheur. 0,20 $ par défaut."
          >
            <Input
              id="proactive-cap"
              type="number"
              min={0.01}
              max={5}
              step={0.01}
              value={p.maxCostUsd}
              onChange={(e) => setP({ ...p, maxCostUsd: Number(e.target.value) })}
            />
          </Field>
          <Field id="proactive-day" label="Missions max. par 24 h" hint="Tous déclencheurs confondus.">
            <Input
              id="proactive-day"
              type="number"
              min={1}
              max={200}
              value={p.maxRunsPerDay}
              onChange={(e) => setP({ ...p, maxRunsPerDay: Number(e.target.value) })}
            />
          </Field>
        </div>
        <ErrorBox error={save.error} />
        <Button
          variant="primary"
          icon={<Save className="size-4" />}
          disabled={!dirty}
          pending={save.pending}
          onClick={() => void save.run()}
        >
          Enregistrer la politique
        </Button>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ form

const defaultSpec = (kind: TriggerSpec['kind']): TriggerSpec =>
  kind === 'cron'
    ? { kind, expression: '0 8 * * *' }
    : kind === 'interval'
      ? { kind, minutes: 60 }
      : kind === 'event'
        ? { kind, event: 'any', path: '', pattern: '*', recursive: false, cooldownSec: 60 }
        : { kind, condition: 'mission_failed', sourceTriggerId: null, maxRetries: 1, delayMinutes: 0 };

function TriggerForm({
  initial,
  triggers,
  variables,
  cap,
  onClose,
  onSaved,
}: {
  initial: ScheduledTrigger | null;
  triggers: ScheduledTrigger[];
  variables: string[];
  cap: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [spec, setSpec] = useState<TriggerSpec>(initial?.spec ?? defaultSpec('cron'));
  const [template, setTemplate] = useState(initial?.missionTemplate ?? '');
  const [cost, setCost] = useState<string>(initial?.budget.maxCostUsd?.toString() ?? '');
  const [autoStart, setAutoStart] = useState(initial?.autoStart ?? true);
  const policy = useResource<{ allowedRoots: string[] }>('/api/policy', { live: false });
  const [preview, setPreview] = useState<{ description: string; upcoming: string[] } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (spec.kind !== 'cron' && spec.kind !== 'interval') return;
    const t = window.setTimeout(() => {
      api<{ description: string; upcoming: string[] }>('/api/triggers/preview', { body: { spec } })
        .then((p) => {
          setPreview(p);
          setPreviewError(null);
        })
        .catch((e: Error) => {
          setPreview(null);
          setPreviewError(e.message);
        });
    }, 300);
    return () => window.clearTimeout(t);
  }, [spec]);

  const body = () => ({
    name,
    spec,
    missionTemplate: template,
    budget: cost === '' ? {} : { maxCostUsd: Number(cost) },
    autoStart,
  });
  const save = useAction(
    () =>
      initial
        ? api(`/api/triggers/${initial.id}`, { method: 'PATCH', body: body() })
        : api('/api/triggers', { body: body() }),
    onSaved,
  );
  const timeBased = spec.kind === 'cron' || spec.kind === 'interval';
  const sources = triggers.filter((t) => t.kind !== 'condition' && t.id !== initial?.id);
  const set = <K extends TriggerSpec['kind']>(patch: Partial<Extract<TriggerSpec, { kind: K }>>) =>
    setSpec((s) => ({ ...s, ...patch }) as TriggerSpec);

  return (
    <Card
      title={initial ? `Modifier « ${initial.name} »` : 'Nouveau déclencheur'}
      icon={<CalendarClock className="size-4" />}
      actions={
        <Button variant="ghost" aria-label="Fermer" icon={<X className="size-4" />} onClick={onClose} />
      }
      className="mb-4"
    >
      <form
        className="grid gap-3 lg:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run();
        }}
      >
        <div className="space-y-3">
          <Field id="trg-name" label="Nom">
            <Input
              id="trg-name"
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field id="trg-kind" label="Type de déclencheur">
            <Select
              id="trg-kind"
              value={spec.kind}
              onChange={(e) => setSpec(defaultSpec(e.target.value as TriggerSpec['kind']))}
            >
              {Object.entries(KIND_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          {spec.kind === 'cron' && (
            <Field
              id="trg-cron"
              label="Expression cron (minute heure jour mois jour-de-semaine, heure locale)"
              hint={previewError ?? preview?.description}
            >
              <Input
                id="trg-cron"
                className="font-mono"
                value={spec.expression}
                onChange={(e) => set<'cron'>({ expression: e.target.value })}
              />
              <div className="mt-1 flex flex-wrap gap-1">
                {CRON_PRESETS.map(([e, l]) => (
                  <button
                    key={e}
                    type="button"
                    className="press rounded-md bg-raised px-1.5 py-0.5 text-xs ring-1 ring-line ring-inset hover:ring-line-strong"
                    onClick={() => set<'cron'>({ expression: e })}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </Field>
          )}
          {spec.kind === 'interval' && (
            <Field id="trg-minutes" label="Intervalle (minutes, 5 minimum)" hint={previewError ?? undefined}>
              <Input
                id="trg-minutes"
                type="number"
                min={5}
                max={10080}
                value={spec.minutes}
                onChange={(e) => set<'interval'>({ minutes: Number(e.target.value) })}
              />
            </Field>
          )}
          {spec.kind === 'event' && (
            <>
              <Field
                id="trg-path"
                label="Dossier surveillé"
                hint={`Doit se trouver dans un dossier autorisé : ${policy.data?.allowedRoots.join(' ; ') ?? '…'}`}
              >
                <Input
                  id="trg-path"
                  required
                  value={spec.path}
                  placeholder={policy.data?.allowedRoots[0]}
                  onChange={(e) => set<'event'>({ path: e.target.value })}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field id="trg-event" label="Événement">
                  <Select
                    id="trg-event"
                    value={spec.event}
                    onChange={(e) => set<'event'>({ event: e.target.value as 'any' })}
                  >
                    <option value="any">Créé ou modifié</option>
                    <option value="created">Créé</option>
                    <option value="changed">Modifié</option>
                  </Select>
                </Field>
                <Field id="trg-pattern" label="Motif du nom">
                  <Input
                    id="trg-pattern"
                    value={spec.pattern}
                    onChange={(e) => set<'event'>({ pattern: e.target.value })}
                  />
                </Field>
                <Field id="trg-cool" label="Regroupement (s)">
                  <Input
                    id="trg-cool"
                    type="number"
                    min={10}
                    value={spec.cooldownSec}
                    onChange={(e) => set<'event'>({ cooldownSec: Number(e.target.value) })}
                  />
                </Field>
              </div>
              <Switch
                id="trg-recursive"
                label="Inclure les sous-dossiers"
                checked={spec.recursive}
                onChange={(recursive) => set<'event'>({ recursive })}
              />
            </>
          )}
          {spec.kind === 'condition' && (
            <>
              <Field id="trg-source" label="Missions surveillées">
                <Select
                  id="trg-source"
                  value={spec.sourceTriggerId ?? ''}
                  onChange={(e) => set<'condition'>({ sourceTriggerId: e.target.value || null })}
                >
                  <option value="">Toute mission en échec</option>
                  {sources.map((t) => (
                    <option key={t.id} value={t.id}>
                      Missions de « {t.name} »
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="trg-retries" label="Nouvelles tentatives max.">
                  <Input
                    id="trg-retries"
                    type="number"
                    min={1}
                    max={3}
                    value={spec.maxRetries}
                    onChange={(e) => set<'condition'>({ maxRetries: Number(e.target.value) })}
                  />
                </Field>
                <Field id="trg-delay" label="Délai avant tentative (min)">
                  <Input
                    id="trg-delay"
                    type="number"
                    min={0}
                    max={1440}
                    value={spec.delayMinutes}
                    onChange={(e) => set<'condition'>({ delayMinutes: Number(e.target.value) })}
                  />
                </Field>
              </div>
            </>
          )}
          {timeBased && preview && preview.upcoming.length > 0 && (
            <div className="text-xs text-muted">
              <p className="font-medium">Prochaines exécutions</p>
              <ul className="mt-1 flex flex-wrap gap-1">
                {preview.upcoming.slice(0, 5).map((u) => (
                  <li key={u}>
                    <Badge>{fmtDate(u)}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="space-y-3">
          <Field
            id="trg-template"
            label="Demande de la mission"
            hint={
              <>
                Variables : {variables.join(' ')}. Les noms de fichiers et messages d’erreur sont insérés
                entre guillemets, comme des données.
              </>
            }
          >
            <Textarea
              id="trg-template"
              required
              rows={5}
              maxLength={4000}
              value={template}
              placeholder="Résume les actualités tech du {{date}} et enregistre la synthèse en mémoire"
              onChange={(e) => setTemplate(e.target.value)}
            />
          </Field>
          <Field
            id="trg-cost"
            label="Budget de la mission (USD)"
            hint={`Vide : plafond de la politique (${cap.toFixed(2)} $). Une valeur supérieure est ramenée au plafond.`}
          >
            <Input
              id="trg-cost"
              type="number"
              min={0}
              step={0.01}
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </Field>
          <Switch
            id="trg-autostart"
            label="Démarrer automatiquement après la planification"
            description="Désactivé : le plan attend votre validation dans Missions. Les actions sensibles demandent toujours une approbation."
            checked={autoStart}
            onChange={setAutoStart}
          />
          <ErrorBox error={save.error} />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" icon={<Save className="size-4" />} pending={save.pending}>
              {initial ? 'Enregistrer' : 'Créer le déclencheur'}
            </Button>
            <Button onClick={onClose}>Annuler</Button>
          </div>
        </div>
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------ history

function RunHistory({ triggers }: { triggers: ScheduledTrigger[] }) {
  const runs = useResource<TriggerRun[]>('/api/trigger-runs?limit=100');
  const navigate = useApp((s) => s.navigate);
  const names = new Map(triggers.map((t) => [t.id, t.name]));
  return (
    <Card title="Historique des missions automatiques" icon={<History className="size-4" />} className="mt-4">
      {runs.loading && !runs.data && <Loading />}
      <ErrorBox error={runs.error?.message} />
      {runs.data?.length === 0 && <Empty>Aucune exécution pour l’instant.</Empty>}
      {!!runs.data?.length && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">Date</th>
                <th className="py-1 pr-3 font-medium">Déclencheur</th>
                <th className="py-1 pr-3 font-medium">Motif</th>
                <th className="py-1 pr-3 font-medium">Statut</th>
                <th className="py-1 pr-3 font-medium">Coût</th>
                <th className="py-1 font-medium">Mission</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id} className="border-t border-line align-top">
                  <td className="py-1.5 pr-3 whitespace-nowrap">{fmtDate(r.firedAt)}</td>
                  <td className="py-1.5 pr-3">{names.get(r.triggerId) ?? r.triggerId}</td>
                  <td className="py-1.5 pr-3">
                    <span className="block max-w-md">{r.reason}</span>
                    {r.error && <span className="block text-xs text-danger-fg">{r.error}</span>}
                  </td>
                  <td className="py-1.5 pr-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    {r.mission
                      ? `${r.mission.usage.costKnown ? '' : '≥ '}${fmtUsd(r.mission.usage.costUsd)}`
                      : '—'}
                  </td>
                  <td className="py-1.5">
                    {r.missionId ? (
                      <button
                        type="button"
                        className="text-xs text-accent-fg hover:underline"
                        onClick={() => navigate('missions', r.missionId)}
                      >
                        Ouvrir
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

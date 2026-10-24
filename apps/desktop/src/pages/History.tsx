import { useState } from 'react';
import { Database, Download, FileDown, Plus, Save, Trash2 } from 'lucide-react';
import { api, downloadFile, downloadJson } from '../api';
import { useAction, useResource } from '../hooks';
import { useApp } from '../store';
import type { MemoryEntry, MemoryKind, Mission } from '../types';
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
  Textarea,
  fmtDate,
} from '../components/ui';

const KIND_LABEL: Record<MemoryKind, string> = {
  mission_summary: 'Résumé de mission',
  preference: 'Préférence explicite',
  procedure: 'Procédure',
  knowledge: 'Connaissance',
};

export function HistoryPage() {
  return (
    <>
      <PageHeader
        title="Historique et mémoire"
        subtitle="Recherche des missions, rapports, mémoire persistante et maintenance"
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <MissionSearch />
        <Maintenance />
      </div>
      <MemoryManager />
    </>
  );
}

function MissionSearch() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const list = useResource<Mission[]>(
    `/api/missions?limit=100${query ? `&search=${encodeURIComponent(query)}` : ''}`,
  );
  const navigate = useApp((s) => s.navigate);
  const exportReport = useAction((id: string) =>
    downloadFile(`/api/missions/${id}/report`, `hermes-${id}.md`),
  );
  return (
    <Card title="Missions">
      <form
        className="mb-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
      >
        <Input
          aria-label="Rechercher dans les missions"
          placeholder="Rechercher dans les demandes et résultats…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button type="submit">Rechercher</Button>
      </form>
      {list.loading && !list.data && <Loading />}
      <ErrorBox error={list.error?.message ?? exportReport.error} />
      {list.data?.length === 0 && <Empty>Aucun résultat.</Empty>}
      <ul className="max-h-96 space-y-1 overflow-auto">
        {list.data?.map((m) => (
          <li key={m.id} className="flex items-center gap-2 text-sm">
            <StatusBadge status={m.status} />
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left hover:underline"
              onClick={() => navigate('missions', m.id)}
            >
              {m.request}
            </button>
            <span className="shrink-0 text-xs text-slate-500">{fmtDate(m.createdAt)}</span>
            <Button
              variant="ghost"
              aria-label="Exporter le rapport"
              icon={<FileDown className="size-4" />}
              onClick={() => void exportReport.run(m.id)}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Maintenance() {
  const [msg, setMsg] = useState<string | null>(null);
  const diag = useAction(
    () => api('/api/diagnostics'),
    (d) => downloadJson(d, `hermes-diagnostic-${new Date().toISOString().slice(0, 10)}.json`),
  );
  const backup = useAction(
    () => api<{ path: string }>('/api/maintenance/backup', { body: {} }),
    (r) => setMsg(`Sauvegarde créée : ${r.path}`),
  );
  const [before, setBefore] = useState('');
  const purge = useAction(
    () =>
      api<{ missions: number; events: number }>('/api/maintenance/purge', {
        body: { before: new Date(before).toISOString() },
      }),
    (r) => setMsg(`Purge effectuée : ${r.missions} mission(s), ${r.events} événement(s) supprimés.`),
  );
  return (
    <Card title="Maintenance et diagnostic">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button
            icon={<Download className="size-4" />}
            pending={diag.pending}
            onClick={() => void diag.run()}
          >
            Exporter le diagnostic (masqué)
          </Button>
          <Button
            icon={<Database className="size-4" />}
            pending={backup.pending}
            onClick={() => void backup.run()}
          >
            Sauvegarder la base
          </Button>
        </div>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (
              before &&
              window.confirm(
                'Supprimer définitivement les missions terminées avant cette date, avec leurs événements d’audit ? Cette action est journalisée et irréversible.',
              )
            )
              void purge.run();
          }}
        >
          <Field
            id="purge-before"
            label="Purger l’historique terminé avant le"
            hint="Opération explicite et journalisée. Les missions en cours ne sont jamais purgées."
          >
            <Input id="purge-before" type="date" value={before} onChange={(e) => setBefore(e.target.value)} />
          </Field>
          <Button
            type="submit"
            variant="danger"
            icon={<Trash2 className="size-4" />}
            disabled={!before}
            pending={purge.pending}
          >
            Purger
          </Button>
        </form>
        {msg && <p className="text-sm">{msg}</p>}
        <ErrorBox error={diag.error ?? backup.error ?? purge.error} />
      </div>
    </Card>
  );
}

function MemoryManager() {
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const mem = useResource<MemoryEntry[]>(
    `/api/memory?${new URLSearchParams({ ...(kind ? { kind } : {}), ...(search ? { search } : {}) })}`,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [newPref, setNewPref] = useState('');
  const add = useAction(
    (content: string) => api('/api/memory', { body: { kind: 'preference', content } }),
    () => {
      setNewPref('');
      mem.reload();
    },
  );
  const del = useAction(
    (ids: string[]) => api('/api/memory', { method: 'DELETE', body: { ids } }),
    () => {
      setSelected([]);
      mem.reload();
    },
  );
  return (
    <Card
      className="mt-4"
      title="Mémoire persistante"
      actions={
        <>
          <Select
            aria-label="Type de souvenir"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="w-48"
          >
            <option value="">Tous les types</option>
            {Object.entries(KIND_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
          <Input
            aria-label="Rechercher dans la mémoire"
            placeholder="Rechercher…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-48"
          />
          <Button
            variant="danger"
            icon={<Trash2 className="size-4" />}
            disabled={!selected.length}
            pending={del.pending}
            onClick={() => void del.run(selected)}
          >
            Supprimer ({selected.length})
          </Button>
        </>
      }
    >
      <form
        className="mb-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (newPref.trim().length >= 2) void add.run(newPref.trim());
        }}
      >
        <Input
          aria-label="Nouvelle préférence"
          placeholder="Ajouter une préférence explicite (ex. : rapports en français, format Markdown)"
          value={newPref}
          onChange={(e) => setNewPref(e.target.value)}
        />
        <Button type="submit" icon={<Plus className="size-4" />} pending={add.pending}>
          Ajouter
        </Button>
      </form>
      <p className="mb-2 text-xs text-slate-500">
        Aucun mot de passe, clé, cookie ou secret n’est enregistré : les contenus sont masqués avant stockage.
        Les entrées « non validé » proviennent d’un agent.
      </p>
      <ErrorBox error={mem.error?.message ?? add.error ?? del.error} />
      {mem.data?.length === 0 && <Empty>Aucun souvenir.</Empty>}
      <ul className="space-y-2">
        {mem.data?.map((m) => (
          <MemoryRow
            key={m.id}
            entry={m}
            selected={selected.includes(m.id)}
            onSelect={(on) => setSelected((s) => (on ? [...s, m.id] : s.filter((x) => x !== m.id)))}
            onSaved={mem.reload}
          />
        ))}
      </ul>
    </Card>
  );
}

function MemoryRow({
  entry: m,
  selected,
  onSelect,
  onSaved,
}: {
  entry: MemoryEntry;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(m.content);
  const [confidence, setConfidence] = useState(m.confidence ?? 0.5);
  const save = useAction(
    () => api(`/api/memory/${m.id}`, { method: 'PATCH', body: { content, confidence } }),
    () => {
      setEditing(false);
      onSaved();
    },
  );
  return (
    <li className="rounded-md border border-slate-200 p-2 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input
          type="checkbox"
          aria-label="Sélectionner"
          checked={selected}
          onChange={(e) => onSelect(e.target.checked)}
        />
        <Badge tone={m.kind === 'preference' ? 'info' : 'neutral'}>{KIND_LABEL[m.kind]}</Badge>
        {m.tags.map((t) => (
          <Badge key={t} tone={t === 'non-validé' ? 'warning' : 'neutral'}>
            {t}
          </Badge>
        ))}
        <span className="text-slate-500">
          origine {m.origin} · {fmtDate(m.updatedAt)} · confiance {m.confidence ?? '—'}
        </span>
        <Button variant="ghost" className="ml-auto" onClick={() => setEditing(!editing)}>
          {editing ? 'Annuler' : 'Modifier'}
        </Button>
      </div>
      {editing ? (
        <div className="mt-2 space-y-2">
          <Textarea
            aria-label="Contenu"
            rows={3}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <label className="flex items-center gap-2 text-xs">
            Confiance
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={confidence}
              onChange={(e) => setConfidence(Number(e.target.value))}
            />
            {confidence.toFixed(1)}
          </label>
          <Button
            variant="primary"
            icon={<Save className="size-4" />}
            pending={save.pending}
            onClick={() => void save.run()}
          >
            Enregistrer
          </Button>
          <ErrorBox error={save.error} />
        </div>
      ) : (
        <p className="mt-1 text-sm whitespace-pre-wrap">{m.content}</p>
      )}
    </li>
  );
}

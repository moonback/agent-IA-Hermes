import { useEffect, useState } from 'react';
import { Camera } from 'lucide-react';
import { api, apiBlobUrl } from '../api';
import { useAction, useResource } from '../hooks';
import type { Artifact, MissionEvent, Status, ToolCallRecord } from '../types';
import { EventList } from '../components/shared';
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, StatusBadge, fmtDate } from '../components/ui';

interface WindowInfo {
  handle: number;
  title: string;
  processName: string | null;
  isForeground: boolean;
}

interface Observation {
  observedAt: string;
  windows: WindowInfo[];
  screenshot: { artifactId: string; width: number; height: number };
}

function Screenshot({ artifact }: { artifact: Artifact }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    apiBlobUrl(`/api/artifacts/${artifact.id}/file`)
      .then((u) => setSrc((url = u)))
      .catch((e: unknown) => setErr(String(e)));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [artifact.id]);
  return (
    <figure className="space-y-1">
      {src ? (
        <img
          src={src}
          alt={`Capture d’écran du ${fmtDate(artifact.createdAt)}`}
          className="w-full rounded border border-slate-200 dark:border-slate-800"
        />
      ) : (
        <ErrorBox error={err} />
      )}
      <figcaption className="text-xs text-slate-500">
        Instantané pris le {fmtDate(artifact.createdAt)} — ce n’est pas une vue en direct.{' '}
        {artifact.description}
      </figcaption>
    </figure>
  );
}

export function ComputerPage() {
  const status = useResource<Status>('/api/status', { live: false });
  const shots = useResource<Artifact[]>('/api/artifacts?kind=screenshot&limit=1');
  const calls = useResource<ToolCallRecord[]>('/api/tool-calls?limit=200');
  const events = useResource<MissionEvent[]>('/api/events?category=desktop&limit=50');
  const [obs, setObs] = useState<Observation | null>(null);
  const observe = useAction(
    () => api<Observation>('/api/desktop/observe', { body: {} }),
    (o) => {
      setObs(o);
      shots.reload();
    },
  );
  const desktop = status.data?.workers.desktop;
  const desktopCalls = (calls.data ?? [])
    .filter((c) => c.toolId.startsWith('desktop.') || c.toolId.startsWith('screen.'))
    .reverse();
  const latest = shots.data?.[0];

  return (
    <>
      <PageHeader
        title="Ordinateur"
        subtitle="Observation du bureau Windows et historique des interactions de l’agent ordinateur"
        actions={
          <Button
            variant="primary"
            icon={<Camera className="size-4" />}
            pending={observe.pending}
            disabled={!desktop?.available}
            onClick={() => void observe.run()}
          >
            Capturer maintenant
          </Button>
        }
      />
      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          <Card title="Adaptateur bureau">
            {desktop ? (
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={desktop.available ? 'success' : 'warning'}>
                  {desktop.available ? 'disponible' : 'indisponible'}
                </Badge>
                Windows UI Automation via un worker PowerShell isolé (actions sémantiques uniquement, aucun
                clic par coordonnées).
                {desktop.reason && <span className="text-red-600">{desktop.reason}</span>}
              </p>
            ) : (
              <Empty>État inconnu.</Empty>
            )}
            <ErrorBox error={observe.error} />
          </Card>
          <Card title="Capture la plus récente">
            {latest ? (
              <Screenshot artifact={latest} />
            ) : (
              <Empty>Aucune capture. Utilisez « Capturer maintenant ».</Empty>
            )}
          </Card>
          <Card title="Historique des interactions">
            {desktopCalls.length === 0 ? (
              <Empty>Aucune action bureau enregistrée.</Empty>
            ) : (
              <ul className="space-y-1 text-sm">
                {desktopCalls.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-slate-500">{fmtDate(c.startedAt)}</span>
                    <code className="text-xs">{c.toolId}</code>
                    <StatusBadge status={c.status} />
                    <span className="truncate text-xs text-slate-500">
                      {JSON.stringify(c.input).slice(0, 140)}
                    </span>
                    {c.error && <span className="text-xs text-red-600">{c.error.slice(0, 140)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Fenêtres (dernière observation manuelle)">
            {obs ? (
              <ul className="space-y-1 text-sm">
                <li className="text-xs text-slate-500">Observé le {fmtDate(obs.observedAt)}</li>
                {obs.windows.map((w) => (
                  <li key={w.handle} className="flex items-center gap-2">
                    {w.isForeground && <Badge tone="info">active</Badge>}
                    <span className="truncate" title={w.title}>
                      {w.title}
                    </span>
                    <code className="ml-auto text-xs text-slate-500">{w.processName}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>Pas encore observé dans cette session.</Empty>
            )}
          </Card>
          <Card title="Observations et actions de l’agent">
            <EventList events={events.data ?? []} />
          </Card>
        </div>
      </div>
    </>
  );
}

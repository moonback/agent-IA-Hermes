import { useState } from 'react';
import { Send } from 'lucide-react';
import { api } from '../api';
import { useAction, useResource } from '../hooks';
import { useApp } from '../store';
import type { Mission, Status } from '../types';
import { MissionView } from '../components/MissionView';
import { Button, Card, Empty, ErrorBox, PageHeader, StatusBadge, Textarea } from '../components/ui';

export function ChatPage() {
  const [text, setText] = useState('');
  const { selectedMissionId, navigate } = useApp();
  const status = useResource<Status>('/api/status', { live: false });
  const missions = useResource<Mission[]>('/api/missions?limit=15');
  const create = useAction(
    (request: string) => api<Mission>('/api/missions', { body: { request } }),
    (m) => {
      setText('');
      navigate('chat', m.id);
    },
  );
  const noModel = status.data && !status.data.provider.assignments.primary;
  const noKey = status.data && !status.data.provider.hasKey;

  return (
    <>
      <PageHeader
        title="Chat"
        subtitle="Décrivez une mission : HERMES propose un plan validé, que vous démarrez ensuite."
      />
      <div className="grid gap-4 xl:grid-cols-[18rem_1fr]">
        <Card title="Conversations récentes">
          {missions.data?.length ? (
            <ul className="space-y-1">
              {missions.data.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    aria-current={m.id === selectedMissionId || undefined}
                    className="flex w-full flex-col items-start gap-0.5 rounded p-1.5 text-left text-sm hover:bg-slate-100 aria-[current]:bg-slate-100 dark:hover:bg-slate-800 dark:aria-[current]:bg-slate-800"
                    onClick={() => navigate('chat', m.id)}
                  >
                    <StatusBadge status={m.status} />
                    <span className="line-clamp-2">{m.request}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Aucune mission.</Empty>
          )}
        </Card>
        <div className="space-y-4">
          <Card>
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim().length >= 2) void create.run(text.trim());
              }}
            >
              <label htmlFor="mission-input" className="text-sm font-medium">
                Nouvelle mission
              </label>
              <Textarea
                id="mission-input"
                rows={4}
                value={text}
                maxLength={8000}
                placeholder="Ex. : Recherche les fichiers PDF du dossier de travail et prépare un classement par année dans un rapport."
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey))
                    (e.currentTarget.form as HTMLFormElement).requestSubmit();
                }}
              />
              {(noKey || noModel) && (
                <ErrorBox
                  title="OpenRouter non configuré"
                  error={`${noKey ? 'Aucune clé API. ' : ''}${noModel ? 'Aucun modèle principal sélectionné. ' : ''}Configurez-les dans « Modèles et OpenRouter » : la planification échouera sinon.`}
                />
              )}
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Ctrl + Entrée pour envoyer</span>
                <Button
                  type="submit"
                  variant="primary"
                  icon={<Send className="size-4" />}
                  pending={create.pending}
                  disabled={text.trim().length < 2}
                >
                  Planifier
                </Button>
              </div>
              <ErrorBox error={create.error} />
            </form>
          </Card>
          {selectedMissionId ? (
            <MissionView missionId={selectedMissionId} />
          ) : (
            <Empty>Sélectionnez ou créez une mission.</Empty>
          )}
        </div>
      </div>
    </>
  );
}

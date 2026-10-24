import { useState } from 'react';
import { MessageSquare, Send } from 'lucide-react';
import { api } from '../api';
import { useAction, useResource } from '../hooks';
import { useApp } from '../store';
import type { Mission, Status } from '../types';
import { MissionView } from '../components/MissionView';
import { MissionListItem } from '../components/cards';
import { ProviderWarning } from '../components/shared';
import { Button, Card, Empty, ErrorBox, PageHeader, Textarea } from '../components/ui';

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
                  <MissionListItem
                    mission={m}
                    selected={m.id === selectedMissionId}
                    onSelect={() => navigate('chat', m.id)}
                  />
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
              <ProviderWarning status={status.data} />
              <div className="flex items-center justify-between">
                <span className="text-xs text-faint">
                  <kbd className="rounded bg-raised px-1 ring-1 ring-line">Ctrl</kbd> +{' '}
                  <kbd className="rounded bg-raised px-1 ring-1 ring-line">Entrée</kbd> pour envoyer
                </span>
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
            <Card>
              <Empty icon={<MessageSquare className="size-5" />}>Sélectionnez ou créez une mission.</Empty>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

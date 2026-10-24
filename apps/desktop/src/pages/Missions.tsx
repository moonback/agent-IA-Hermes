import { useState } from 'react';
import { ListChecks } from 'lucide-react';
import { useResource } from '../hooks';
import { useApp } from '../store';
import type { Mission } from '../types';
import { MissionView } from '../components/MissionView';
import { MissionListItem } from '../components/cards';
import { Card, Empty, ErrorBox, Loading, PageHeader, Select } from '../components/ui';

const FILTERS: [string, string][] = [
  ['', 'Toutes'],
  ['planning,planned,running,paused,interrupted', 'Non terminées'],
  ['running', 'En cours'],
  ['interrupted,paused', 'Interrompues / en pause'],
  ['completed', 'Terminées'],
  ['failed', 'Échouées'],
  ['cancelled', 'Annulées'],
];

export function MissionsPage() {
  const [filter, setFilter] = useState('');
  const { selectedMissionId, navigate } = useApp();
  const list = useResource<Mission[]>(`/api/missions?limit=100${filter ? `&status=${filter}` : ''}`);
  return (
    <>
      <PageHeader
        title="Missions"
        subtitle="Étapes, dépendances, agents, tentatives, durées, preuves et erreurs"
      />
      <div className="grid gap-4 xl:grid-cols-[22rem_1fr]">
        <Card
          className="xl:sticky xl:top-0 xl:max-h-[calc(100vh-var(--topbar-height)-3rem)] xl:overflow-y-auto"
          title="Liste"
          actions={
            <Select
              aria-label="Filtrer par statut"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-44"
            >
              {FILTERS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          }
        >
          {list.loading && !list.data && <Loading />}
          <ErrorBox error={list.error?.message} />
          {list.data?.length === 0 && <Empty>Aucune mission.</Empty>}
          <ul className="space-y-1">
            {list.data?.map((m) => (
              <li key={m.id}>
                <MissionListItem
                  mission={m}
                  selected={m.id === selectedMissionId}
                  onSelect={() => navigate('missions', m.id)}
                />
              </li>
            ))}
          </ul>
        </Card>
        <div>
          {selectedMissionId ? (
            <MissionView missionId={selectedMissionId} />
          ) : (
            <Card>
              <Empty icon={<ListChecks className="size-5" />}>
                Sélectionnez une mission dans la liste pour voir son plan, ses étapes et ses preuves.
              </Empty>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

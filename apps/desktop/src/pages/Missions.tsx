import { useState } from 'react';
import { useResource } from '../hooks';
import { useApp } from '../store';
import type { Mission } from '../types';
import { MissionView } from '../components/MissionView';
import { Card, Empty, ErrorBox, Loading, PageHeader, Select, StatusBadge, fmtDate } from '../components/ui';

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
                <button
                  type="button"
                  aria-current={m.id === selectedMissionId || undefined}
                  onClick={() => navigate('missions', m.id)}
                  className="flex w-full flex-col gap-0.5 rounded p-2 text-left text-sm hover:bg-slate-100 aria-[current]:bg-slate-100 dark:hover:bg-slate-800 dark:aria-[current]:bg-slate-800"
                >
                  <span className="flex items-center gap-2">
                    <StatusBadge status={m.status} />
                    <span className="text-xs text-slate-500">{fmtDate(m.createdAt)}</span>
                  </span>
                  <span className="line-clamp-2">{m.request}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <div>
          {selectedMissionId ? (
            <MissionView missionId={selectedMissionId} />
          ) : (
            <Empty>Sélectionnez une mission.</Empty>
          )}
        </div>
      </div>
    </>
  );
}

import { useState } from 'react';
import { LayoutGrid, ListChecks, List as ListIcon, Plus, Search, X } from 'lucide-react';
import { useResource } from '../hooks';
import { useApp } from '../store';
import type { Mission } from '../types';
import { MissionView } from '../components/MissionView';
import { MissionCard, MissionListItem } from '../components/cards';
import { Button, Card, Empty, ErrorBox, Input, Loading, PageHeader, Select } from '../components/ui';

const FILTERS: [string, string][] = [
  ['', 'Toutes'],
  ['planning,planned,running,paused,interrupted', 'Non terminées'],
  ['running', 'En cours'],
  ['interrupted,paused', 'Interrompues / en pause'],
  ['completed', 'Terminées'],
  ['failed', 'Échouées'],
  ['cancelled', 'Annulées'],
];

type View = 'list' | 'cards';

export function MissionsPage() {
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<View>('list');
  const { selectedMissionId, navigate } = useApp();
  const query = new URLSearchParams({ limit: '100' });
  if (filter) query.set('status', filter);
  if (search.trim()) query.set('search', search.trim());
  const list = useResource<Mission[]>(`/api/missions?${query.toString()}`);

  return (
    <>
      <PageHeader
        title="Missions"
        subtitle="Suivez les étapes, les agents, les décisions et les preuves du travail exécuté."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate('chat', null)}>
            Nouvelle mission
          </Button>
        }
      />
      <div className="grid gap-4 xl:grid-cols-[22rem_1fr]">
        <Card
          className="xl:sticky xl:top-0 xl:max-h-[calc(100vh-var(--topbar-height)-3rem)] xl:overflow-y-auto"
          title={`Missions${list.data ? ` · ${list.data.length}` : ''}`}
          actions={
            <div className="flex items-center gap-1">
              <Button
                variant={view === 'list' ? 'secondary' : 'ghost'}
                className="px-2"
                aria-label="Affichage en liste"
                aria-pressed={view === 'list'}
                onClick={() => setView('list')}
              >
                <ListIcon className="size-4" />
              </Button>
              <Button
                variant={view === 'cards' ? 'secondary' : 'ghost'}
                className="px-2"
                aria-label="Affichage en cartes"
                aria-pressed={view === 'cards'}
                onClick={() => setView('cards')}
              >
                <LayoutGrid className="size-4" />
              </Button>
            </div>
          }
        >
          <div className="mb-3 grid gap-2">
            <label className="relative block">
              <Search
                className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-faint"
                aria-hidden
              />
              <Input
                aria-label="Rechercher dans les missions"
                placeholder="Rechercher une demande ou un résultat…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pr-9 pl-9"
              />
              {search && (
                <button
                  type="button"
                  aria-label="Effacer la recherche"
                  onClick={() => setSearch('')}
                  className="absolute top-2 right-2 rounded p-0.5 text-faint hover:text-fg"
                >
                  <X className="size-4" />
                </button>
              )}
            </label>
            <Select
              aria-label="Filtrer par statut"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              {FILTERS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          {list.loading && !list.data && <Loading />}
          <ErrorBox error={list.error?.message} />
          {list.data?.length === 0 && (
            <Empty icon={<ListChecks className="size-5" />}>
              {search || filter ? 'Aucune mission ne correspond à ces critères.' : 'Aucune mission.'}
            </Empty>
          )}
          {view === 'list' ? (
            <ul className="space-y-1">
              {list.data?.map((mission) => (
                <li key={mission.id}>
                  <MissionListItem
                    mission={mission}
                    selected={mission.id === selectedMissionId}
                    onSelect={() => navigate('missions', mission.id)}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
              {list.data?.map((mission) => (
                <MissionCard
                  key={mission.id}
                  mission={mission}
                  onOpen={() => navigate('missions', mission.id)}
                />
              ))}
            </div>
          )}
        </Card>
        <div>
          {selectedMissionId ? (
            <MissionView key={selectedMissionId} missionId={selectedMissionId} />
          ) : (
            <Card>
              <Empty icon={<ListChecks className="size-5" />}>
                Sélectionnez une mission pour consulter son plan, ses étapes et ses preuves.
              </Empty>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

import { Brain, History, Info, Palette, ShieldCheck } from 'lucide-react';
import { useMediaQuery, useResource } from '../hooks';
import { usePrefs } from '../prefs';
import { useApp } from '../store';
import type { Status } from '../types';
import { THEME_INFO } from '../theme';
import { ThemeSelector } from '../components/theme/ThemeSelector';
import { Button, Card, DataList, ErrorBox, Loading, PageHeader, Switch } from '../components/ui';

export function SettingsPage() {
  const prefs = usePrefs();
  const navigate = useApp((s) => s.navigate);
  const status = useResource<Status>('/api/status', { live: false });
  const osReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const osReducedTransparency = useMediaQuery('(prefers-reduced-transparency: reduce)');
  const s = status.data;

  return (
    <>
      <PageHeader title="Paramètres" subtitle="Préférences de l’interface et informations de diagnostic" />
      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          <Card title="Apparence" icon={<Palette className="size-4" />}>
            <p className="mb-3 text-sm text-muted">
              Thème actif : <span className="font-medium text-fg">{THEME_INFO[prefs.theme].name}</span>. Le
              changement est immédiat et mémorisé sur cet ordinateur.
            </p>
            <ThemeSelector value={prefs.theme} onChange={prefs.setTheme} />
            <div className="mt-5 space-y-4 border-t border-line pt-4">
              <Switch
                id="pref-transparency"
                label="Réduire la transparence"
                description={
                  osReducedTransparency
                    ? 'Windows demande déjà moins de transparence : les surfaces sont opaques.'
                    : 'Remplace le verre flouté par des surfaces opaques (lisibilité, machines peu puissantes).'
                }
                checked={prefs.reducedTransparency}
                onChange={prefs.setReducedTransparency}
              />
              <Switch
                id="pref-sidebar"
                label="Barre latérale réduite"
                description="Affiche uniquement les icônes. Elle est toujours réduite dans les fenêtres étroites."
                checked={prefs.sidebarCollapsed}
                onChange={prefs.toggleSidebar}
              />
              <Switch
                id="pref-activity"
                label="Panneau d’activité"
                description="Panneau latéral (fenêtres d’au moins 1440 px) : service, missions actives, événements en direct."
                checked={prefs.activityPanel}
                onChange={prefs.toggleActivityPanel}
              />
            </div>
            <p className="mt-4 text-xs text-faint">
              L’apparence est une simple préférence d’affichage : elle ne modifie ni les permissions, ni les
              outils disponibles, ni la politique de sécurité de HERMES.
              {osReducedMotion && ' Les animations sont désactivées, conformément au réglage de Windows.'}
            </p>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="À propos" icon={<Info className="size-4" />}>
            {status.loading && !s && <Loading />}
            <ErrorBox error={status.error?.message} />
            {s && (
              <DataList
                rows={[
                  ['Version', s.version],
                  ['Démarrage du service', `${s.startupMs} ms`],
                  ['Données', <code className="text-xs">{s.dataDir}</code>, s.dataDir],
                  [
                    'Coffre de la clé',
                    s.provider.hasKey
                      ? s.provider.source === 'env'
                        ? 'variable d’environnement'
                        : 'coffre du système'
                      : 'aucune clé',
                  ],
                ]}
              />
            )}
          </Card>
          <Card title="Autres réglages">
            <div className="flex flex-col gap-2">
              <Button
                icon={<Brain className="size-4" />}
                onClick={() => navigate('models')}
                className="justify-start"
              >
                Modèles, clé OpenRouter et budgets
              </Button>
              <Button
                icon={<ShieldCheck className="size-4" />}
                onClick={() => navigate('tools')}
                className="justify-start"
              >
                Sécurité : permissions et audit
              </Button>
              <Button
                icon={<History className="size-4" />}
                onClick={() => navigate('history')}
                className="justify-start"
              >
                Maintenance, sauvegarde et diagnostic
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

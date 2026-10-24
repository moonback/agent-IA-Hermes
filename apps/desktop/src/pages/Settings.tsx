import { useState } from 'react';
import { AudioLines, Brain, History, Info, Palette, Save, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { useAction, useMediaQuery, useResource } from '../hooks';
import { usePrefs } from '../prefs';
import { useApp } from '../store';
import type { Status, VoiceCatalog, VoiceSettings } from '../types';
import { THEME_INFO } from '../theme';
import { ThemeSelector } from '../components/theme/ThemeSelector';
import {
  Button,
  Card,
  DataList,
  ErrorBox,
  Field,
  Loading,
  PageHeader,
  Select,
  Switch,
} from '../components/ui';

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
          <VoiceSettingsCard />
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

function VoiceSettingsCard() {
  const settings = useResource<VoiceSettings>('/api/voice/settings', { live: false });
  const catalog = useResource<VoiceCatalog>('/api/voice/catalog', { live: false });
  if (!settings.data || !catalog.data)
    return (
      <Card title="Voix de l’assistant" icon={<AudioLines className="size-4" />}>
        {settings.error || catalog.error ? (
          <ErrorBox error={(settings.error ?? catalog.error)!.message} />
        ) : (
          <Loading />
        )}
      </Card>
    );
  // Remounted when the server copy changes, so the form always starts from saved values.
  return (
    <VoiceForm
      key={JSON.stringify(settings.data)}
      initial={settings.data}
      catalog={catalog.data}
      onSaved={settings.reload}
    />
  );
}

function VoiceForm({
  initial,
  catalog,
  onSaved,
}: {
  initial: VoiceSettings;
  catalog: VoiceCatalog;
  onSaved: () => void;
}) {
  const [v, setV] = useState(initial);
  const save = useAction(() => api('/api/voice/settings', { method: 'PUT', body: v }), onSaved);
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  return (
    <Card
      title="Voix de l’assistant"
      icon={<AudioLines className="size-4" />}
      actions={
        <Button
          variant="primary"
          icon={<Save className="size-4" />}
          disabled={!dirty}
          pending={save.pending}
          onClick={() => void save.run()}
        >
          Enregistrer les réglages vocaux
        </Button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="voice-name" label={`Voix (${catalog.voices.length} voix HD Gemini)`}>
          <Select
            id="voice-name"
            value={v.voiceName}
            onChange={(e) => setV({ ...v, voiceName: e.target.value })}
          >
            {catalog.voices.map((x) => (
              <option key={x.name} value={x.name}>
                {x.name} — {x.style}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="voice-lang" label={`Langue (${catalog.languages.length} langues)`}>
          <Select
            id="voice-lang"
            value={v.languageCode}
            onChange={(e) => setV({ ...v, languageCode: e.target.value })}
          >
            {catalog.languages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="voice-mode" label="Mode du micro par défaut">
          <Select
            id="voice-mode"
            value={v.mode}
            onChange={(e) => setV({ ...v, mode: e.target.value as VoiceSettings['mode'] })}
          >
            <option value="vad">Mains libres (détection de la voix)</option>
            <option value="ptt">Appuyer pour parler</option>
          </Select>
        </Field>
        <Field
          id="voice-sensitivity"
          label={`Sensibilité du micro : ${Math.round(v.vadSensitivity * 100)} %`}
          hint="Plus bas si le bruit ambiant déclenche le micro."
        >
          <input
            id="voice-sensitivity"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={v.vadSensitivity}
            onChange={(e) => setV({ ...v, vadSensitivity: Number(e.target.value) })}
            className="w-full accent-(--hm-accent)"
          />
        </Field>
      </div>
      <div className="mt-4 border-t border-line pt-4">
        <Switch
          id="voice-affective"
          label="Dialogue affectif"
          description="Gemini adapte le ton de sa voix à l’émotion perçue dans la vôtre."
          checked={v.affectiveDialogue}
          onChange={(affectiveDialogue) => setV({ ...v, affectiveDialogue })}
        />
      </div>
      <p className="mt-3 text-xs text-faint">
        Modèle vocal : <code>{catalog.model}</code> (rôle « voice », modifiable dans « Modèles et OpenRouter
        »). Les réglages s’appliquent à la prochaine conversation.
      </p>
    </Card>
  );
}

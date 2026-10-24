import { PageHeader } from '../components/ui';
import { VoicePanel } from '../components/voice/VoicePanel';

export function VoicePage() {
  return (
    <>
      <PageHeader
        title="Assistant vocal"
        subtitle="Parlez à HERMES (Gemini Live) : questions, nouvelles missions et commandes de contrôle"
      />
      <VoicePanel />
    </>
  );
}

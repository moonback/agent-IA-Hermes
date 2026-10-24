import { z } from 'zod';

/** Prebuilt Gemini HD voices (names are Google's; the French style hints are ours). */
export const GEMINI_VOICES = [
  ['Zephyr', 'lumineuse'],
  ['Puck', 'enjouée'],
  ['Charon', 'informative'],
  ['Kore', 'ferme'],
  ['Fenrir', 'vive'],
  ['Leda', 'jeune'],
  ['Orus', 'assurée'],
  ['Aoede', 'légère'],
  ['Callirrhoe', 'décontractée'],
  ['Autonoe', 'claire'],
  ['Enceladus', 'soufflée'],
  ['Iapetus', 'nette'],
  ['Umbriel', 'détendue'],
  ['Algieba', 'douce'],
  ['Despina', 'fluide'],
  ['Erinome', 'limpide'],
  ['Algenib', 'graveleuse'],
  ['Rasalgethi', 'pédagogue'],
  ['Laomedeia', 'entraînante'],
  ['Achernar', 'feutrée'],
  ['Alnilam', 'résolue'],
  ['Schedar', 'égale'],
  ['Gacrux', 'mûre'],
  ['Pulcherrima', 'directe'],
  ['Achird', 'amicale'],
  ['Zubenelgenubi', 'familière'],
  ['Vindemiatrix', 'calme'],
  ['Sadachbia', 'animée'],
  ['Sadaltager', 'savante'],
  ['Sulafat', 'chaleureuse'],
] as const;

export const GEMINI_LIVE_LANGUAGES = [
  ['fr-FR', 'Français (France)'],
  ['fr-CA', 'Français (Canada)'],
  ['en-US', 'Anglais (États-Unis)'],
  ['en-GB', 'Anglais (Royaume-Uni)'],
  ['en-AU', 'Anglais (Australie)'],
  ['en-IN', 'Anglais (Inde)'],
  ['de-DE', 'Allemand'],
  ['es-ES', 'Espagnol (Espagne)'],
  ['es-US', 'Espagnol (États-Unis)'],
  ['it-IT', 'Italien'],
  ['pt-BR', 'Portugais (Brésil)'],
  ['nl-NL', 'Néerlandais'],
  ['pl-PL', 'Polonais'],
  ['ru-RU', 'Russe'],
  ['tr-TR', 'Turc'],
  ['ar-XA', 'Arabe'],
  ['hi-IN', 'Hindi'],
  ['bn-IN', 'Bengali'],
  ['ja-JP', 'Japonais'],
  ['ko-KR', 'Coréen'],
  ['cmn-CN', 'Chinois mandarin'],
  ['id-ID', 'Indonésien'],
  ['vi-VN', 'Vietnamien'],
  ['th-TH', 'Thaï'],
] as const;

const voiceNames = GEMINI_VOICES.map(([v]) => v) as [string, ...string[]];
const languageCodes = GEMINI_LIVE_LANGUAGES.map(([c]) => c) as [string, ...string[]];

export const VoiceSettings = z.object({
  voiceName: z.enum(voiceNames).default('Kore'),
  languageCode: z.enum(languageCodes).default('fr-FR'),
  affectiveDialogue: z.boolean().default(true),
  /** 'vad': hands-free with client-side voice detection; 'ptt': push-to-talk. */
  mode: z.enum(['vad', 'ptt']).default('vad'),
  /** 0 = only loud speech opens the microphone, 1 = very sensitive. */
  vadSensitivity: z.number().min(0).max(1).default(0.5),
});
export type VoiceSettings = z.infer<typeof VoiceSettings>;

export const DEFAULT_LIVE_MODEL = 'gemini-3.8-live';

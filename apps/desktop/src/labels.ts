// User-facing labels for server states, shared by every screen.

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const STATUS_TONE: Record<string, Tone> = {
  pending: 'neutral',
  ready: 'info',
  running: 'info',
  planning: 'info',
  planned: 'neutral',
  waiting_approval: 'warning',
  paused: 'warning',
  interrupted: 'warning',
  blocked: 'warning',
  completed: 'success',
  succeeded: 'success',
  approved: 'success',
  consumed: 'success',
  failed: 'danger',
  denied: 'danger',
  cancelled: 'neutral',
  expired: 'neutral',
  deduplicated: 'info',
  abandoned: 'neutral',
  started: 'warning',
};

export const STATUS_LABEL: Record<string, string> = {
  pending: 'en attente',
  ready: 'prête',
  running: 'en cours',
  planning: 'planification',
  planned: 'planifiée',
  waiting_approval: 'approbation requise',
  paused: 'en pause',
  interrupted: 'interrompue',
  blocked: 'bloquée',
  completed: 'terminée',
  succeeded: 'réussi',
  failed: 'échec',
  cancelled: 'annulée',
  denied: 'refusé',
  approved: 'approuvé',
  consumed: 'utilisée',
  expired: 'expirée',
  deduplicated: 'dédoublonné',
  abandoned: 'abandonné',
  started: 'incertain',
};

export const CONNECTION_LABEL: Record<string, [string, Tone]> = {
  ok: ['Connecté (test réussi)', 'success'],
  config_missing: ['Configuration manquante', 'warning'],
  auth_invalid: ['Clé invalide ou accès refusé', 'danger'],
  network: ['Problème réseau', 'danger'],
  model_unavailable: ['Modèle indisponible', 'danger'],
  insufficient_credits: ['Crédit insuffisant', 'danger'],
  rate_limited: ['Limite de débit', 'warning'],
  provider_error: ['Erreur fournisseur', 'danger'],
};

/** Connection state as last measured by a real test; never assumed from the mere presence of a key. */
export function connectionState(provider: {
  hasKey: boolean;
  lastTest: { status: string } | null;
}): [string, Tone] {
  if (!provider.hasKey) return CONNECTION_LABEL.config_missing!;
  if (!provider.lastTest) return ['Clé présente, non testée', 'neutral'];
  return CONNECTION_LABEL[provider.lastTest.status] ?? ['Inconnu', 'neutral'];
}

export const RISK_TONE = { low: 'success', medium: 'warning', high: 'danger' } as const;
export const RISK_LABEL = { low: 'faible', medium: 'moyen', high: 'élevé' } as const;

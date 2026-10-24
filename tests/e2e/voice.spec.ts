// Voice assistant end to end: real HERMES service + UI, SIMULATED Gemini Live (local WebSocket)
// and Chromium's simulated microphone. Proves the whole chain except Google's actual service.
import { expect, test, type Page } from '@playwright/test';

const nav = (page: Page, label: string) =>
  page
    .getByRole('navigation', { name: 'Navigation principale' })
    .getByRole('button', { name: label, exact: true })
    .click();
const GEMINI_KEY = `AIzaSy${'E'.repeat(33)}`;

test.describe.configure({ mode: 'serial' });

test('clé Gemini requise, enregistrée et testée (session Live réelle vers le simulateur)', async ({
  page,
}) => {
  await page.goto('/');
  await nav(page, 'Assistant vocal');
  await expect(page.getByRole('heading', { name: 'Assistant vocal', level: 1 })).toBeVisible();
  await expect(page.getByText('Clé Gemini manquante')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Démarrer la conversation' })).toBeDisabled();

  await page.getByRole('button', { name: 'Configurer Gemini' }).click();
  await expect(page.getByRole('heading', { name: 'Modèles et OpenRouter', level: 1 })).toBeVisible();
  await page.getByLabel('Clé API Gemini').fill(GEMINI_KEY);
  await page.getByRole('button', { name: 'Enregistrer la clé Gemini' }).click();
  await expect(page.getByLabel('Clé API Gemini')).toHaveValue('');
  await expect(page.getByText('aucune clé Gemini')).toHaveCount(0);
  await page.getByRole('button', { name: 'Tester Gemini Live' }).click();
  await expect(page.getByText('Session Live établie avec gemini-3.8-live.')).toBeVisible();
  // The key never comes back to the interface.
  expect(await page.content()).not.toContain(GEMINI_KEY);
});

test('conversation écrite : transcription en direct et réponse de HERMES', async ({ page }) => {
  await page.goto('/');
  await nav(page, 'Assistant vocal');
  await page.getByRole('button', { name: 'Démarrer la conversation' }).click();
  await expect(page.getByRole('button', { name: 'Terminer' })).toBeVisible();
  await page.getByLabel('Écrire à l’assistant vocal').fill('Bonjour HERMES');
  await page.getByRole('button', { name: 'Envoyer' }).click();
  const transcript = page.getByRole('list', { name: 'Transcription' });
  await expect(transcript.getByText('Bonjour HERMES')).toBeVisible();
  await expect(transcript.getByText('Bonjour, je vous écoute.')).toBeVisible();
  // A special command typed alone runs deterministically and is reported in the conversation.
  await page.getByLabel('Écrire à l’assistant vocal').fill('Rapport');
  await page.getByRole('button', { name: 'Envoyer' }).click();
  await expect(transcript.getByText(/^Rapport : /)).toBeVisible();
  await page.getByRole('button', { name: 'Terminer' }).click();
  await expect(page.getByRole('button', { name: 'Démarrer la conversation' })).toBeVisible();
});

test('voix (micro simulé) → mission réelle, visible dans le panneau et dans l’historique', async ({
  page,
}) => {
  await page.goto('/');
  await nav(page, 'Assistant vocal');
  await page.getByRole('button', { name: 'Démarrer la conversation' }).click();
  const transcript = page.getByRole('list', { name: 'Transcription' });
  // The fake microphone's tone passes the voice detector; the simulator transcribes it and calls mission_create.
  await expect(transcript.getByText('Écris un rapport vocal')).toBeVisible({ timeout: 20_000 });
  await expect(transcript.getByText('Je prépare le plan du rapport.')).toBeVisible();
  const card = page.getByRole('button', { name: /Écrire un rapport vocal/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText(/planification|planifiée/);
  await page.getByRole('button', { name: 'Terminer' }).click();

  await nav(page, 'Historique et mémoire');
  await expect(page.getByRole('button', { name: /Écrire un rapport vocal/ }).first()).toBeVisible();
});

test('réglages vocaux : voix, langue et mode mémorisés côté service', async ({ page }) => {
  await page.goto('/');
  await nav(page, 'Paramètres');
  await page.getByLabel(/^Voix \(30 voix HD Gemini\)/).selectOption('Puck');
  await page.getByLabel(/^Langue \(24 langues\)/).selectOption('en-GB');
  await page.getByLabel('Mode du micro par défaut').selectOption('ptt');
  await page.getByRole('button', { name: 'Enregistrer les réglages vocaux' }).click();
  await expect(page.getByRole('button', { name: 'Enregistrer les réglages vocaux' })).toBeDisabled();
  await page.reload();
  await nav(page, 'Paramètres');
  await expect(page.getByLabel(/^Voix \(30/)).toHaveValue('Puck');
  await expect(page.getByLabel(/^Langue \(24/)).toHaveValue('en-GB');
  await nav(page, 'Assistant vocal');
  await expect(page.getByRole('radio', { name: 'Appuyer pour parler' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

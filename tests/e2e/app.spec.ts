// End-to-end UI tests against the real HERMES service and a SIMULATED OpenRouter.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const stack = () =>
  JSON.parse(readFileSync(join(import.meta.dirname, '../../test-results/e2e-stack.json'), 'utf8')) as {
    dataDir: string;
    workspace: string;
  };
const nav = (page: Page, label: string) =>
  page
    .getByRole('navigation', { name: 'Navigation principale' })
    .getByRole('button', { name: label, exact: true })
    .click();

test.describe.configure({ mode: 'serial' });

test('démarrage de l’interface et clé absente', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
  await expect(page.getByText('Service local connecté')).toBeVisible();
  await expect(page.getByText('Configuration manquante').first()).toBeVisible();
  await nav(page, 'Modèles et OpenRouter');
  await page.getByRole('button', { name: 'Tester la connexion' }).click();
  await expect(page.getByText('Aucune clé API OpenRouter configurée.')).toBeVisible();
});

test('configuration OpenRouter et affichage des erreurs API', async ({ page }) => {
  await page.goto('/');
  await nav(page, 'Modèles et OpenRouter');
  await page.getByLabel('Clé API OpenRouter').fill('sk-or-v1-e2etestkeye2etestkeye2etestkey00');
  await page.getByRole('button', { name: 'Enregistrer' }).first().click();
  await expect(page.getByText(/clé enregistrée/)).toBeVisible();
  await expect(page.getByLabel('Clé API OpenRouter')).toHaveValue('');

  await page.getByLabel('Principal (défaut)').fill('mock/no-credit');
  await page.getByRole('button', { name: 'Enregistrer' }).nth(1).click();
  await page.getByRole('button', { name: 'Tester la connexion' }).click();
  await expect(page.getByText('Crédit insuffisant')).toBeVisible();

  await page.getByLabel('Principal (défaut)').fill('mock/model');
  await page.getByRole('button', { name: 'Enregistrer' }).nth(1).click();
  await page.getByRole('button', { name: 'Tester la connexion' }).click();
  await expect(page.getByText('Connecté (test réussi)')).toBeVisible();

  await page.getByRole('button', { name: 'Actualiser' }).click();
  await expect(page.getByRole('cell', { name: 'mock/model', exact: true })).toBeVisible();
});

test('mission : plan affiché, exécution, événements et vérification', async ({ page }) => {
  await page.goto('/');
  await nav(page, 'Chat');
  await page.getByLabel('Nouvelle mission').fill('Écris un rapport de test');
  await page.getByRole('button', { name: 'Planifier' }).click();
  await expect(page.getByRole('heading', { name: 'Plan validé' })).toBeVisible();
  await expect(page.getByText('Écrire rapport-e2e.txt').first()).toBeVisible();
  await page.getByRole('button', { name: 'Démarrer' }).click();
  await expect(page.getByRole('heading', { name: 'Résultat consolidé' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('vérification : pass')).toBeVisible();
  await expect(page.getByText('tool.succeeded').first()).toBeVisible();
  expect(readFileSync(join(stack().workspace, 'rapport-e2e.txt'), 'utf8')).toBe('Rapport E2E');
});

test('annulation d’une mission', async ({ page }) => {
  await page.goto('/');
  await nav(page, 'Chat');
  await page.getByLabel('Nouvelle mission').fill('Écris un autre rapport');
  await page.getByRole('button', { name: 'Planifier' }).click();
  await expect(page.getByRole('button', { name: 'Démarrer' })).toBeVisible();
  await page.getByRole('button', { name: 'Annuler' }).click();
  await expect(page.getByText("Mission annulée : Annulée par l'utilisateur").first()).toBeVisible();
});

test('approbation humaine, pause puis reprise', async ({ page }) => {
  writeFileSync(join(stack().workspace, 'note.txt'), 'note');
  await page.goto('/');
  await nav(page, 'Chat');
  await page.getByLabel('Nouvelle mission').fill('Déplace la note dans archives');
  await page.getByRole('button', { name: 'Planifier' }).click();
  await page.getByRole('button', { name: 'Démarrer' }).click();
  await expect(page.getByText('Approbation requise').first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('button', { name: 'Approuver cette action' }).first().click();
  await expect(page.getByRole('button', { name: 'Reprendre' })).toBeVisible({ timeout: 20_000 });
  expect(existsSync(join(stack().workspace, 'archives', 'note.txt'))).toBe(true);
  await page.getByRole('button', { name: 'Reprendre' }).click();
  await expect(page.getByText('vérification : pass')).toBeVisible({ timeout: 30_000 });
});

test('pages de supervision accessibles et réelles', async ({ page }) => {
  await page.goto('/');
  for (const [label, heading] of [
    ['Missions', 'Missions'],
    ['Ordinateur', 'Ordinateur'],
    ['Agents', 'Agents'],
    ['Outils et permissions', 'Outils et permissions'],
    ['Historique et mémoire', 'Historique et mémoire'],
  ] as const) {
    await nav(page, label);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
  }
  await nav(page, 'Outils et permissions');
  await expect(page.getByText('files.write', { exact: true })).toBeVisible();
  await nav(page, 'Agents');
  await expect(page.getByText('Vérificateur')).toBeVisible();
});

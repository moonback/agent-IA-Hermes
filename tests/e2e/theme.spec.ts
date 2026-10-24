// UI shell, appearance and accessibility, against the real HERMES service (simulated OpenRouter).
import { expect, test, type Page } from '@playwright/test';
import { STATUS_LABEL } from '../../apps/desktop/src/labels';

const nav = (page: Page, label: string) =>
  page
    .getByRole('navigation', { name: 'Navigation principale' })
    .getByRole('button', { name: label, exact: true })
    .click();
// String expressions: the test project is type-checked without the DOM library.
const rootTheme = (page: Page) => page.evaluate<string | undefined>('document.documentElement.dataset.theme');
const transparency = (page: Page) =>
  page.evaluate<string | undefined>('document.documentElement.dataset.transparency');
const ROUTES = [
  'Tableau de bord',
  'Chat',
  'Missions',
  'Agents',
  'Ordinateur',
  'Historique et mémoire',
  'Modèles et OpenRouter',
  'Outils et permissions',
  'Paramètres',
];

test.describe.configure({ mode: 'serial' });

test('Glass Dark par défaut, puis les trois thèmes sélectionnables sans rechargement', async ({ page }) => {
  await page.goto('/');
  expect(await rootTheme(page)).toBe('glass-dark');
  await page.evaluate('window.__noReload = true');

  await nav(page, 'Paramètres');
  await expect(page.getByRole('heading', { name: 'Paramètres', level: 1 })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Glass Dark' })).toBeChecked();
  for (const [name, value] of [
    ['Glass Light', 'glass-light'],
    ['Glass Cyberpunk', 'glass-cyberpunk'],
    ['Glass Dark', 'glass-dark'],
  ] as const) {
    await page.getByText(name, { exact: true }).click();
    await expect(page.getByRole('radio', { name })).toBeChecked();
    expect(await rootTheme(page)).toBe(value);
  }
  // Same document: the window marker survived every switch.
  expect(await page.evaluate('window.__noReload')).toBe(true);
});

test('le thème choisi est restauré au redémarrage, avant même le chargement de React', async ({ page }) => {
  await page.goto('/');
  await nav(page, 'Paramètres');
  await page.getByText('Glass Cyberpunk', { exact: true }).click();
  await page.reload();
  expect(await rootTheme(page)).toBe('glass-cyberpunk');
  await nav(page, 'Paramètres');
  await expect(page.getByRole('radio', { name: 'Glass Cyberpunk' })).toBeChecked();

  // Without the application bundle, only public/theme-boot.js can have set the theme (no flash).
  await page.route('**/src/main.tsx', (r) => r.abort());
  await page.reload();
  expect(await rootTheme(page)).toBe('glass-cyberpunk');
  expect(await page.evaluate('document.documentElement.style.colorScheme')).toBe('dark');
});

test('une préférence invalide ou ancienne retombe sur un thème valide', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('hermes.theme', 'néon-violet'));
  await page.reload();
  expect(await rootTheme(page)).toBe('glass-dark');
  await page.evaluate(() => localStorage.setItem('hermes.theme', 'light'));
  await page.reload();
  expect(await rootTheme(page)).toBe('glass-light');
  await page.evaluate(() => localStorage.removeItem('hermes.theme'));
});

test('sélecteur de thème et navigation utilisables au clavier', async ({ page }) => {
  await page.goto('/');
  await nav(page, 'Paramètres');
  await page.getByRole('radio', { name: 'Glass Dark' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Glass Light' })).toBeChecked();
  expect(await rootTheme(page)).toBe('glass-light');
  await expect(page.getByRole('radio', { name: 'Glass Light' })).toBeFocused();

  const sidebar = page.getByRole('navigation', { name: 'Navigation principale' });
  await sidebar.getByRole('button', { name: 'Tableau de bord', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(sidebar.getByRole('button', { name: 'Chat', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Chat', level: 1 })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await nav(page, 'Paramètres');
  const sw = page.getByRole('switch', { name: 'Réduire la transparence' });
  await sw.focus();
  await page.keyboard.press('Space');
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  expect(await transparency(page)).toBe('reduced');
  await page.keyboard.press('Space');
  expect(await transparency(page)).toBeUndefined();
  await page.evaluate(() => localStorage.removeItem('hermes.theme'));
});

test('toutes les routes restent accessibles, barre latérale déployée ou réduite', async ({ page }) => {
  await page.goto('/');
  for (const label of ROUTES) {
    await nav(page, label);
    await expect(page.getByRole('heading', { name: label, level: 1 })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Réduire la barre latérale' }).click();
  await page.reload();
  // Collapsed rail: labels are visually hidden but remain the accessible names.
  await expect(page.getByRole('button', { name: 'Déployer la barre latérale' })).toBeVisible();
  for (const label of ROUTES) {
    await nav(page, label);
    await expect(page.getByRole('heading', { name: label, level: 1 })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Déployer la barre latérale' }).click();

  await page.setViewportSize({ width: 980, height: 700 });
  await expect(page.getByRole('button', { name: 'Déployer la barre latérale' })).toHaveCount(0);
  await nav(page, 'Agents');
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
  const overflow = await page.evaluate<number>(
    "(() => { const m = document.querySelector('main'); return m.scrollWidth - m.clientWidth; })()",
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('les cartes du tableau de bord affichent les données réelles du service', async ({ page }) => {
  const created = (await (
    await page.request.post('/api/missions', { data: { request: 'Carte de test E2E' } })
  ).json()) as {
    id: string;
  };
  let status = 'planning';
  for (let i = 0; i < 100 && status === 'planning'; i++) {
    status = (
      (await (await page.request.get(`/api/missions/${created.id}`)).json()) as {
        mission: { status: string };
      }
    ).mission.status;
    if (status === 'planning') await page.waitForTimeout(100);
  }
  await page.goto('/');
  const card = page.getByRole('button', { name: /Carte de test E2E/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText(STATUS_LABEL[status]!);
  await card.click();
  await expect(page.getByRole('heading', { name: 'Missions', level: 1 })).toBeVisible();
  await expect(page.getByText(created.id)).toBeVisible();

  const agents = (await (await page.request.get('/api/agents')).json()) as { name: string }[];
  await nav(page, 'Tableau de bord');
  for (const a of agents) await expect(page.getByRole('heading', { name: a.name, level: 3 })).toBeVisible();
});

test('états de chargement et d’erreur', async ({ page }) => {
  await page.route('**/api/agents', async (r) => {
    await new Promise((res) => setTimeout(res, 1200));
    await r.continue();
  });
  await page.goto('/');
  await nav(page, 'Agents');
  await expect(page.getByRole('status').filter({ hasText: 'Chargement…' })).toBeVisible();
  await expect(page.getByText('Agents enregistrés')).toBeVisible();

  await page.unroute('**/api/agents');
  await page.route('**/api/agents', (r) => r.abort());
  await nav(page, 'Missions');
  await nav(page, 'Agents');
  await expect(page.getByRole('alert').filter({ hasText: 'Service local HERMES injoignable' })).toBeVisible();
});

test('les commandes globales fonctionnent toujours : arrêt d’urgence puis réarmement', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Arrêt d’urgence' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Arrêt d’urgence actif' })).toBeVisible();
  await page.getByRole('button', { name: 'Réarmer HERMES' }).click();
  await expect(page.getByRole('button', { name: 'Arrêt d’urgence' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Arrêt d’urgence actif' })).toHaveCount(0);
});

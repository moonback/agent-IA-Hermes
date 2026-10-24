// End-to-end stack: SIMULATED OpenRouter + real HERMES service (test mode) + Vite UI on port 1421.
// Started by Playwright (webServer). The simulated model never proves the real API works.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scenarioHandler, startMockServer } from '../helpers/mock-openrouter';

const root = join(import.meta.dirname, '..', '..');
const dataDir = mkdtempSync(join(tmpdir(), 'hermes-e2e-'));
const ws = join(dataDir, 'workspace');
mkdirSync(ws, { recursive: true });
const token = randomBytes(32).toString('hex');
const UI_PORT = 1421;

const step = (objective: string, tools: string[]) => ({
  summary: objective,
  successCriteria: ['résultat vérifié par les outils'],
  steps: [
    {
      id: 's1',
      objective,
      agent: 'files',
      tools,
      successCriteria: ['appel d’outil réussi'],
      maxAttempts: 1,
      timeoutSec: 60,
    },
  ],
});

const mock = await startMockServer(
  scenarioHandler({
    modelErrors: { 'mock/no-credit': 402 },
    plan: (req: string) =>
      /déplace/i.test(req)
        ? step('Déplacer note.txt dans archives', ['files.move'])
        : step('Écrire rapport-e2e.txt', ['files.write']),
    agent: (body, turn) => {
      const brief = JSON.stringify(body.messages[1]?.content ?? '');
      if (brief.includes('Déplacer')) {
        return turn === 0
          ? {
              call: {
                name: 'files.move',
                args: { moves: [{ from: join(ws, 'note.txt'), to: join(ws, 'archives', 'note.txt') }] },
              },
            }
          : { complete: { summary: 'note.txt déplacé dans archives' } };
      }
      return turn === 0
        ? {
            call: {
              name: 'files.write',
              args: { path: join(ws, 'rapport-e2e.txt'), content: 'Rapport E2E' },
            },
          }
        : { complete: { summary: 'Rapport écrit' } };
    },
  }),
);

const env = {
  ...process.env,
  HERMES_TOKEN: token,
  HERMES_DATA_DIR: dataDir,
  HERMES_TEST_MODE: '1',
  HERMES_ALLOWED_ORIGINS: `http://127.0.0.1:${UI_PORT}`,
};
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const server = spawn(process.execPath, [tsx, join(root, 'apps/server/src/main.ts')], {
  env,
  stdio: ['ignore', 'pipe', 'inherit'],
});
const port = await new Promise<number>((resolve, reject) => {
  server.stdout.on('data', (c: Buffer) => {
    const m = /HERMES_READY port=(\d+)/.exec(c.toString());
    if (m) resolve(Number(m[1]));
  });
  server.on('exit', (code) => reject(new Error(`service arrêté (${code})`)));
});

// Points the provider at the local simulation (allowed only in test mode).
const res = await fetch(`http://127.0.0.1:${port}/api/provider/settings`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    baseUrl: mock.url,
    timeoutMs: 10000,
    maxRetries: 0,
    temperature: 0.2,
    maxOutputTokens: 1000,
  }),
});
if (!res.ok) throw new Error(`configuration du fournisseur simulé impossible : ${await res.text()}`);

mkdirSync(join(root, 'test-results'), { recursive: true });
writeFileSync(join(root, 'test-results', 'e2e-stack.json'), JSON.stringify({ dataDir, workspace: ws }));

const vite = spawn(process.execPath, [join(root, 'apps/desktop/node_modules/vite/bin/vite.js')], {
  cwd: join(root, 'apps/desktop'),
  env: { ...env, HERMES_API_URL: `http://127.0.0.1:${port}`, HERMES_UI_PORT: String(UI_PORT) },
  stdio: 'inherit',
});

const stop = () => {
  vite.kill();
  server.kill();
  mock.server.close();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', stop);

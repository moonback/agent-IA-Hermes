import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_KEY_NAME,
  MemorySecretStore,
  UnavailableDesktopAdapter,
  createRuntime,
  type DesktopAdapter,
  type HermesRuntime,
  type MissionEvent,
} from '@hermes/core';
import { mockFetch, scenarioHandler, type Scenario } from './mock-openrouter';

export const TEST_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef';

export function tempDir(prefix = 'hermes-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface TestRuntime {
  rt: HermesRuntime;
  dir: string;
  workspace: string;
  calls: ReturnType<typeof mockFetch>['calls'];
  cleanup: () => Promise<void>;
}

/** Isolated runtime: temp data dir, in-memory secret store, simulated OpenRouter, no real desktop. */
export async function createTestRuntime(
  sc: Scenario | ((workspace: string) => Scenario) = {},
  opts: { withKey?: boolean; desktop?: DesktopAdapter } = {},
): Promise<TestRuntime> {
  const dir = tempDir();
  const secrets = new MemorySecretStore();
  if (opts.withKey ?? true) await secrets.set(API_KEY_NAME, TEST_KEY);
  const { fetchImpl, calls } = mockFetch(
    scenarioHandler(typeof sc === 'function' ? sc(join(dir, 'workspace')) : sc),
  );
  const rt = await createRuntime({
    dataDir: dir,
    secrets,
    fetchImpl,
    desktop: opts.desktop ?? new UnavailableDesktopAdapter('désactivé pour les tests'),
  });
  rt.settings.setAssignment('primary', 'mock/model', []);
  await rt.catalog.refresh();
  return {
    rt,
    dir,
    workspace: join(dir, 'workspace'),
    calls,
    cleanup: async () => {
      await rt.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Resolves when an event matching the predicate is recorded (or rejects after a timeout). */
export function waitForEvent(
  rt: HermesRuntime,
  pred: (e: MissionEvent) => boolean,
  timeoutMs = 20_000,
): Promise<MissionEvent> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      rt.telemetry.off('event', on);
      reject(new Error('événement attendu non reçu'));
    }, timeoutMs);
    const on = (e: MissionEvent) => {
      if (pred(e)) {
        clearTimeout(t);
        rt.telemetry.off('event', on);
        resolve(e);
      }
    };
    rt.telemetry.on('event', on);
  });
}

export async function waitForMissionStatus(
  rt: HermesRuntime,
  id: string,
  statuses: string[],
  timeoutMs = 30_000,
) {
  const start = Date.now();
  for (;;) {
    const m = rt.store.requireMission(id);
    if (statuses.includes(m.status)) return m;
    if (Date.now() - start > timeoutMs)
      throw new Error(`Statut ${statuses.join('/')} non atteint (actuel : ${m.status}, erreur : ${m.error})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export function filesPlan(path: string, extra: Record<string, unknown> = {}) {
  return {
    summary: 'Écrire un rapport dans le dossier de travail',
    successCriteria: ['Le fichier rapport existe avec le contenu attendu'],
    steps: [
      {
        id: 's1',
        objective: `Écrire le fichier ${path}`,
        agent: 'files' as const,
        inputs: { path },
        dependsOn: [] as string[],
        tools: ['files.write'],
        permissions: ['fs.write'],
        risk: 'low' as const,
        timeoutSec: 60,
        maxAttempts: 2,
        successCriteria: ['files.write réussi et contenu relu identique'],
        ...extra,
      },
    ],
  };
}

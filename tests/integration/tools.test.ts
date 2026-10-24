// Real file-system and process tools in a temporary directory (no personal data).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecuteRequest } from '@hermes/core';
import { createTestRuntime, waitForEvent, type TestRuntime } from '../helpers/runtime';

let t: TestRuntime;
let missionId: string;
let taskId: string;

beforeAll(async () => {
  t = await createTestRuntime();
  const m = t.rt.store.createMission('tests outils', t.rt.settings.budget());
  missionId = m.id;
  const tasks = t.rt.store.createTasks(m.id, {
    summary: 'tests',
    successCriteria: ['ok final'],
    steps: [
      {
        id: 's1',
        objective: 'tests',
        agent: 'files',
        inputs: {},
        dependsOn: [],
        tools: [],
        permissions: [],
        risk: 'low',
        timeoutSec: 60,
        maxAttempts: 1,
        successCriteria: ['ok'],
      },
    ],
  });
  taskId = tasks[0]!.id;
  mkdirSync(join(t.workspace, 'docs', '2023'), { recursive: true });
  writeFileSync(join(t.workspace, 'docs', '2023', 'facture.pdf'), '%PDF-1.4 test');
  writeFileSync(join(t.workspace, 'docs', 'notes.md'), '# Notes\ncontenu');
});
afterAll(() => t.cleanup());

const exec = (toolId: string, input: unknown, over: Partial<ExecuteRequest> = {}) =>
  t.rt.executor.execute({
    toolId,
    input,
    missionId,
    taskId,
    agent: 'files',
    stepTools: null,
    signal: new AbortController().signal,
    ...over,
  });

/** Auto-decides the next approval request (as a user clicking in the UI would). */
const autoDecide = (decision: 'approved' | 'denied') =>
  waitForEvent(t.rt, (e) => e.type === 'approval.requested').then((e) =>
    t.rt.approvals.decide((e.data as { approvalId: string }).approvalId, decision),
  );

describe('outils fichiers (réels)', () => {
  it('files.search retourne chemins et métadonnées', async () => {
    const r = await exec('files.search', { root: t.workspace, pattern: '*.pdf' });
    expect(r.ok).toBe(true);
    const out = r.output as { matches: { name: string; size: number; modifiedAt: string }[] };
    expect(out.matches.map((m) => m.name)).toEqual(['facture.pdf']);
    expect(out.matches[0]!.size).toBeGreaterThan(0);
  });
  it('files.read lit un texte et ne lit pas un binaire', async () => {
    const md = await exec('files.read', { path: join(t.workspace, 'docs', 'notes.md') });
    expect((md.output as { content: string }).content).toContain('contenu');
    const pdf = await exec('files.read', { path: join(t.workspace, 'docs', '2023', 'facture.pdf') });
    expect(pdf.output).toMatchObject({ readable: false, content: null });
  });
  it('files.write crée, vérifie par relecture et refuse l’écrasement silencieux', async () => {
    const p = join(t.workspace, 'out', 'rapport.md');
    const r = await exec('files.write', { path: p, content: 'Rapport' });
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(readFileSync(p, 'utf8')).toBe('Rapport');
    const again = await exec('files.write', { path: p, content: 'Autre contenu' });
    expect(again.error?.code).toBe('COLLISION');
  });
  it('files.write en écrasement demande une approbation et sauvegarde l’original', async () => {
    const p = join(t.workspace, 'out', 'rapport.md');
    const [r] = await Promise.all([
      exec('files.write', { path: p, content: 'V2', mode: 'overwrite' }),
      autoDecide('approved'),
    ]);
    expect(r.ok).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('V2');
    const backup = (r.output as { backupPath: string }).backupPath;
    expect(readFileSync(backup, 'utf8')).toBe('Rapport');
  });
  it('files.move : approbation, déplacement vérifié, liste d’annulation et collision', async () => {
    const from = join(t.workspace, 'docs', 'notes.md');
    const to = join(t.workspace, 'classés', 'notes.md');
    const [r] = await Promise.all([exec('files.move', { moves: [{ from, to }] }), autoDecide('approved')]);
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(existsSync(to) && !existsSync(from)).toBe(true);
    expect((r.output as { undo: unknown[] }).undo).toEqual([{ from: to, to: from }]);
    writeFileSync(join(t.workspace, 'a.txt'), 'a');
    writeFileSync(join(t.workspace, 'b.txt'), 'b');
    const [c] = await Promise.all([
      exec('files.move', { moves: [{ from: join(t.workspace, 'a.txt'), to: join(t.workspace, 'b.txt') }] }),
      autoDecide('approved'),
    ]);
    expect(c.error?.code).toBe('COLLISION');
    expect(readFileSync(join(t.workspace, 'b.txt'), 'utf8')).toBe('b');
    const [renamed] = await Promise.all([
      exec('files.move', {
        moves: [{ from: join(t.workspace, 'a.txt'), to: join(t.workspace, 'b.txt') }],
        onCollision: 'rename',
      }),
      autoDecide('approved'),
    ]);
    expect((renamed.output as { moved: { to: string }[] }).moved[0]!.to).toBe(join(t.workspace, 'b (1).txt'));
  });
  it('un refus de l’utilisateur bloque l’action', async () => {
    const from = join(t.workspace, 'b.txt');
    const [r] = await Promise.all([
      exec('files.move', { moves: [{ from, to: join(t.workspace, 'z.txt') }] }),
      autoDecide('denied'),
    ]);
    expect(r.error?.code).toBe('APPROVAL_DENIED');
    expect(existsSync(from)).toBe(true);
  });
});

describe('exécuteur de commandes (réel)', () => {
  const run = (input: unknown) => exec('process.run', input, { agent: 'code' });
  it('lance une commande en lecture seule sans shell et capture le code de sortie', async () => {
    const r = await run({ command: 'node', args: ['--version'], cwd: t.workspace });
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({ exitCode: 0, timedOut: false });
    expect((r.output as { stdout: string }).stdout).toMatch(/^v\d+/);
  });
  it('n’hérite pas des secrets de l’environnement', async () => {
    process.env.OPENROUTER_API_KEY_TEST_LEAK = 'should-not-leak';
    const [r] = await Promise.all([
      run({ command: 'node', args: ['-p', 'JSON.stringify(Object.keys(process.env))'], cwd: t.workspace }),
      autoDecide('approved'),
    ]);
    expect((r.output as { stdout: string }).stdout).not.toContain('OPENROUTER_API_KEY_TEST_LEAK');
    delete process.env.OPENROUTER_API_KEY_TEST_LEAK;
  });
  it('les arguments sont transmis tels quels (pas d’interprétation shell)', async () => {
    const [r] = await Promise.all([
      run({ command: 'node', args: ['-p', 'process.argv[1]', 'a & echo PWNED > x.txt'], cwd: t.workspace }),
      autoDecide('approved'),
    ]);
    expect((r.output as { stdout: string }).stdout.trim()).toBe('a & echo PWNED > x.txt');
    expect(existsSync(join(t.workspace, 'x.txt'))).toBe(false);
  });
  it('l’annulation arrête réellement le processus', async () => {
    const ctrl = new AbortController();
    const started = Date.now();
    const p = Promise.all([
      exec(
        'process.run',
        { command: 'node', args: ['-e', 'setTimeout(()=>{}, 60000)'], cwd: t.workspace },
        { agent: 'code', signal: ctrl.signal },
      ),
      autoDecide('approved'),
    ]);
    await waitForEvent(t.rt, (e) => e.type === 'tool.started' && e.toolId === 'process.run');
    ctrl.abort();
    const [r] = await p;
    expect(r.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

describe('registre et contrôles de l’exécuteur', () => {
  it('refuse un outil inconnu et l’enregistre', async () => {
    const r = await exec('system.shutdown', {});
    expect(r.error?.code).toBe('UNKNOWN_TOOL');
    expect(
      t.rt.store
        .listToolCalls({ missionId })
        .some((c) => c.toolId === 'system.shutdown' && c.status === 'denied'),
    ).toBe(true);
  });
  it('valide les arguments par schéma', async () => {
    const r = await exec('files.read', { path: 42 });
    expect(r.error?.code).toBe('VALIDATION');
  });
  it('marque un outil non implémenté sur la plateforme comme indisponible', async () => {
    const r = await exec('screen.observe', {}, { agent: 'computer' });
    expect(r.error?.code).toBe('POLICY_DENIED');
    expect(r.error?.message).toMatch(/indisponible/);
  });
  it('journalise appels et décisions de politique', () => {
    const types = new Set(t.rt.store.listEvents({ missionId, limit: 2000 }).map((e) => e.type));
    for (const ty of [
      'tool.started',
      'tool.succeeded',
      'policy.allow',
      'policy.approval',
      'approval.requested',
      'approval.approved',
      'tool.rejected',
    ])
      expect(types).toContain(ty);
  });
});

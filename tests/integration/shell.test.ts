// Shell agent tools and process sandbox with REAL child processes (node), in a temporary folder.
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobRunnerPath, spawnSandboxed, validateSessionVar, type ExecuteRequest } from '@hermes/core';
import { createTestRuntime, waitForEvent, type TestRuntime } from '../helpers/runtime';

let t: TestRuntime;
let missionId: string;
let taskId: string;

beforeAll(async () => {
  t = await createTestRuntime();
  // Tests decide approvals themselves only where they are the subject.
  t.rt.settings.setPolicy({
    ...t.rt.settings.policy(),
    allowedCommands: ['node', 'git'],
    approvalRules: { 'shell.pipe': 'never', 'process.run': 'never' },
  });
  const m = t.rt.store.createMission('tests shell', t.rt.settings.budget());
  missionId = m.id;
  taskId = t.rt.store.createTasks(m.id, {
    summary: 'tests',
    successCriteria: ['ok final'],
    steps: [
      {
        id: 's1',
        objective: 'tests',
        agent: 'shell',
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
  })[0]!.id;
});
afterAll(() => t.cleanup());

const exec = (toolId: string, input: unknown, over: Partial<ExecuteRequest> = {}) =>
  t.rt.executor.execute({
    toolId,
    input,
    missionId,
    taskId,
    agent: 'shell',
    stepTools: null,
    signal: new AbortController().signal,
    ...over,
  });
const node = (code: string, ...args: string[]) => ({ command: 'node', args: ['-e', code, ...args] });

describe('shell.pipe : pipeline sans shell', () => {
  it('relie la sortie de chaque étape à l’entrée de la suivante', async () => {
    const r = await exec('shell.pipe', {
      cwd: t.workspace,
      stages: [
        node("console.log('pomme\\nbanane\\ncerise')"),
        node("let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s.toUpperCase()))"),
        node(
          "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(s.trim().split('\\n').length+' lignes : '+s.trim().split('\\n').join(',')))",
        ),
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
    const o = r.output as {
      stdout: string;
      exitCode: number;
      stages: { exitCode: number; sandbox: { kind: string } }[];
    };
    expect(o.stdout.trim()).toBe('3 lignes : POMME,BANANE,CERISE');
    expect(o.stages.map((s) => s.exitCode)).toEqual([0, 0, 0]);
  });
  it('transmet une entrée standard et garde les métacaractères littéraux (aucune injection)', async () => {
    const r = await exec('shell.pipe', {
      cwd: t.workspace,
      stdin: 'entrée',
      stages: [
        node(
          "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(s+' | '+process.argv.slice(1).join(' ')))",
          'a | b > c && d ; $(rm -rf x)',
        ),
        node('process.stdin.pipe(process.stdout)'),
      ],
    });
    expect((r.output as { stdout: string }).stdout.trim()).toBe('entrée | a | b > c && d ; $(rm -rf x)');
  });
  it('échoue si une étape échoue (pipefail) et le vérificateur le voit', async () => {
    const r = await exec('shell.pipe', {
      cwd: t.workspace,
      stages: [node('process.exit(3)'), node('process.stdin.resume()')],
    });
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.verificationDetail).toMatch(/Étape 1 \(node\) : code 3/);
    expect((r.output as { exitCode: number }).exitCode).toBe(3);
  });
  it('refuse une étape dont la commande n’est pas autorisée, et les options git dangereuses', async () => {
    const r = await exec('shell.pipe', {
      cwd: t.workspace,
      stages: [node('1'), { command: 'curl', args: ['https://example.com'] }],
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'POLICY_DENIED' } });
    expect(r.error!.message).toMatch(/curl/);
    const g = await exec('shell.pipe', {
      cwd: t.workspace,
      stages: [{ command: 'git', args: ['-c', 'core.pager=evil', 'log'] }, node('1')],
    });
    expect(g.ok).toBe(false);
  });
  it('demande une approbation quand une étape modifie, et la refuse si l’utilisateur dit non', async () => {
    t.rt.settings.setPolicy({ ...t.rt.settings.policy(), approvalRules: {} });
    const [r] = await Promise.all([
      exec('shell.pipe', { cwd: t.workspace, stages: [node('1'), node('2')] }),
      waitForEvent(t.rt, (e) => e.type === 'approval.requested').then((e) =>
        t.rt.approvals.decide((e.data as { approvalId: string }).approvalId, 'denied'),
      ),
    ]);
    expect(r.ok).toBe(false);
    t.rt.settings.setPolicy({
      ...t.rt.settings.policy(),
      approvalRules: { 'shell.pipe': 'never', 'process.run': 'never' },
    });
  });
});

describe('shell.env : variables de mission', () => {
  it('définit des variables transmises aux commandes de la mission, puis les retire', async () => {
    expect((await exec('shell.env', { action: 'set', name: 'HERMES_ETAPE', value: 'compilation' })).ok).toBe(
      true,
    );
    const r = await exec('process.run', {
      ...node('console.log(process.env.HERMES_ETAPE)'),
      cwd: t.workspace,
    });
    expect((r.output as { stdout: string }).stdout.trim()).toBe('compilation');
    await exec('shell.env', { action: 'unset', name: 'HERMES_ETAPE' });
    expect((await exec('shell.env', { action: 'list' })).output).toEqual({ variables: {} });
  });
  it('refuse les variables qui détournent le chargement des programmes, et les secrets', async () => {
    for (const name of [
      'PATH',
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'GIT_SSH_COMMAND',
      'npm_config_script_shell',
      'API_KEY',
      'GITHUB_TOKEN',
    ])
      expect((await exec('shell.env', { action: 'set', name, value: 'x' })).ok, name).toBe(false);
    expect(() => validateSessionVar('1abc')).toThrow(/invalide/);
    expect(() => validateSessionVar('OK_NAME', 'a\0b')).toThrow(/nul/);
  });
});

describe('arrêt des processus et audit', () => {
  it('délai dépassé : SIGTERM puis SIGKILL après 2 s si le processus l’ignore', async () => {
    const started = Date.now();
    const r = await exec('process.run', {
      ...node("process.on('SIGTERM',()=>console.log('SIGTERM ignoré'));setInterval(()=>{},1000)"),
      cwd: t.workspace,
      timeoutSec: 1,
    });
    const o = r.output as { timedOut: boolean; signal: string | null; stdout: string };
    expect(o.timedOut).toBe(true);
    expect(o.stdout).toContain('SIGTERM ignoré');
    expect(o.signal).toBe(process.platform === 'win32' ? o.signal : 'SIGKILL');
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
    expect(r.verified).toBe(false);
  });
  it('journalise argv, code de sortie, durée et bac à sable de chaque exécution', async () => {
    await exec('process.run', { ...node('process.exit(4)'), cwd: t.workspace });
    const ev = t.rt.store
      .listEvents({ missionId })
      .filter((e) => e.type === 'process.exited')
      .at(-1)!;
    expect(ev.message).toMatch(/node -e process\.exit\(4\) : code 4/);
    const data = ev.data as {
      argv: string[][];
      exitCode: number;
      durationMs: number;
      sandbox: { kind: string; reason: string };
    };
    expect(data.argv).toEqual([['node', '-e', 'process.exit(4)']]);
    expect(data.exitCode).toBe(4);
    expect(data.durationMs).toBeGreaterThan(0);
    if (process.platform !== 'win32')
      expect(data.sandbox).toMatchObject({ kind: 'none', reason: /Windows uniquement/ });
  });
});

describe('bac à sable (côté Node, utilitaire simulé)', () => {
  it('passe les limites à l’utilitaire et lit ses statistiques', async () => {
    // Stand-in with hermes-jobrun's command-line contract (the real one is tested on Windows).
    const fake = join(t.dir, 'fake-jobrun.mjs');
    writeFileSync(
      fake,
      `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2); const sep = a.indexOf('--');
const opt = (k) => a[a.indexOf(k) + 1];
const r = spawnSync(a[sep + 1], a.slice(sep + 2), { stdio: 'inherit' });
writeFileSync(opt('--stats'), JSON.stringify({ sandbox: 'job-object', exitCode: r.status, peakJobMemoryBytes: 52428800, userMs: 30, kernelMs: 12, totalProcesses: 2, activeProcessesAtExit: 1, memoryLimitHit: false, seen: { memoryMb: +opt('--memory-mb'), cpu: +opt('--cpu-percent'), max: +opt('--max-processes') } }));
process.exit(r.status ?? 125);
`,
    );
    chmodSync(fake, 0o755);
    const s = spawnSandboxed(
      {
        file: process.execPath,
        args: ['-e', 'console.log("dans le job")'],
        cwd: t.workspace,
        env: { PATH: process.env.PATH ?? '' },
        stdin: 'ignore',
      },
      { enabled: true, memoryMb: 512, cpuPercent: 50, maxProcesses: 8 },
      { runner: fake },
    );
    let out = '';
    s.child.stdout!.on('data', (c: Buffer) => (out += c));
    const code = await new Promise((r) => s.child.on('close', r));
    expect(code).toBe(0);
    expect(out.trim()).toBe('dans le job');
    expect(s.report()).toEqual({
      kind: 'job-object',
      reason: null,
      limits: { memoryMb: 512, cpuPercent: 50, maxProcesses: 8 },
      peakMemoryBytes: 52428800,
      cpuMs: 42,
      totalProcesses: 2,
      leftoverProcesses: 1,
      memoryLimitHit: false,
    });
  });
  it('ne prétend jamais être confiné quand il ne l’est pas', () => {
    const s = spawnSandboxed(
      { file: process.execPath, args: ['-e', '0'], cwd: t.workspace, env: {}, stdin: 'ignore' },
      { enabled: false, memoryMb: 512, cpuPercent: 50, maxProcesses: 8 },
    );
    expect(s.report()).toMatchObject({ kind: 'none', reason: /désactivé/, limits: null });
    expect(jobRunnerPath({}, 'linux')).toBeNull();
  });
});

// Real Job Object, Windows only (CI builds workers/jobrun first).
const runner = jobRunnerPath();
describe.runIf(process.platform === 'win32' && runner)('Job Object Windows réel (hermes-jobrun)', () => {
  it('limite la mémoire et tue les descendants restés en vie', async () => {
    const big = spawnSandboxed(
      {
        file: process.execPath,
        args: ['-e', 'const a=[];for(;;)a.push(Buffer.alloc(16*1024*1024,1))'],
        cwd: t.workspace,
        env: { SYSTEMROOT: process.env.SYSTEMROOT ?? '' },
        stdin: 'ignore',
      },
      { enabled: true, memoryMb: 128, cpuPercent: 100, maxProcesses: 8 },
    );
    const code = await new Promise((r) => big.child.on('close', r));
    expect(code).not.toBe(0);
    expect(big.report()).toMatchObject({ kind: 'job-object', memoryLimitHit: true });

    const orphan = spawnSandboxed(
      {
        file: process.execPath,
        args: [
          '-e',
          "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref()",
        ],
        cwd: t.workspace,
        env: { SYSTEMROOT: process.env.SYSTEMROOT ?? '' },
        stdin: 'ignore',
      },
      { enabled: true, memoryMb: 512, cpuPercent: 100, maxProcesses: 8 },
    );
    await new Promise((r) => orphan.child.on('close', r));
    expect(orphan.report()).toMatchObject({ kind: 'job-object', totalProcesses: 2, leftoverProcesses: 1 });
  }, 60_000);
});

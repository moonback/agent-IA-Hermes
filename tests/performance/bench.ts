// Performance measurements. The model is SIMULATED (no network latency, no real reasoning):
// numbers measure HERMES' own overhead, not end-to-end latency with a real OpenRouter model.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestRuntime, filesPlan, tempDir, waitForMissionStatus } from '../helpers/runtime';

const root = join(import.meta.dirname, '..', '..');
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { n: s.length, min: s[0]!, p50: q(0.5), p95: q(0.95), max: s[s.length - 1]! };
};
const round = (o: Record<string, number>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 10) / 10]));

async function serviceStartup(runs = 5): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const dir = tempDir('hermes-bench-');
    const t0 = performance.now();
    const child = spawn(process.execPath, [join(root, 'apps/server/dist/hermes-server.mjs')], {
      env: {
        ...process.env,
        HERMES_TOKEN: randomBytes(32).toString('hex'),
        HERMES_DATA_DIR: dir,
        HERMES_TEST_MODE: '1',
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    await new Promise<void>((resolve) =>
      child.stdout.on('data', (c: Buffer) => c.toString().includes('HERMES_READY') && resolve()),
    );
    out.push(performance.now() - t0);
    child.kill();
    await new Promise((r) => child.on('exit', r));
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

const results: Record<string, unknown> = {
  date: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  model: 'SIMULÉ',
};

results.serviceStartupMs = round(stats(await serviceStartup()));

const N = 20;
const t = await createTestRuntime((ws) => ({
  // The planner message also carries memory notes: only the mission number names the file.
  plan: (req: string) => filesPlan(join(ws, `mission-${/mission (\d+)/.exec(req)?.[1] ?? 'x'}.txt`)),
  agent: (body, turn) => {
    // The task brief is JSON after its first line; the planned path is in `entrees.path`.
    const brief = String(body.messages[1]?.content ?? '');
    const path = (JSON.parse(brief.slice(brief.indexOf('{'))) as { entrees: { path: string } }).entrees.path;
    return turn === 0
      ? { call: { name: 'files.write', args: { path, content: 'bench' } } }
      : { complete: { summary: 'écrit' } };
  },
}));
const rt = t.rt;

const createMs: number[] = [];
const planMs: number[] = [];
const missionMs: number[] = [];
let completed = 0;
let aiCalls = 0;
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  const m = rt.orchestrator.createMission(`mission ${i}`);
  createMs.push(performance.now() - t0);
  await waitForMissionStatus(rt, m.id, ['planned', 'failed']);
  planMs.push(performance.now() - t0);
  const t1 = performance.now();
  rt.orchestrator.start(m.id);
  const done = await waitForMissionStatus(rt, m.id, ['completed', 'failed']);
  missionMs.push(performance.now() - t1);
  if (done.status === 'completed' && done.result?.verification?.verdict === 'pass') completed++;
  else if (process.env.BENCH_DEBUG)
    console.error(
      i,
      done.status,
      done.error,
      JSON.stringify(
        rt.store.listToolCalls({ missionId: m.id }).map((c) => [c.toolId, c.status, c.error, c.input]),
      ),
    );
  aiCalls += done.usage.aiCalls;
}
results.missionCreateMs = round(stats(createMs));
results.planningMs = round(stats(planMs));
results.missionExecutionMs = round(stats(missionMs));
results.aiCallsPerMission = aiCalls / N;
results.verifiedSuccessRate = completed / N;
results.failureRate = (N - completed) / N;

const missionId = rt.store.createMission('bench outils', rt.settings.budget()).id;
mkdirSync(join(t.workspace, 'bench'), { recursive: true });
for (let i = 0; i < 200; i++) writeFileSync(join(t.workspace, 'bench', `f${i}.txt`), `fichier ${i}`);
const toolLatency = async (toolId: string, input: (i: number) => unknown, runs = 50) => {
  const xs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = await rt.executor.execute({
      toolId,
      input: input(i),
      missionId,
      taskId: null,
      agent: 'files',
      stepTools: null,
      signal: new AbortController().signal,
    });
    if (!r.ok) throw new Error(`${toolId} : ${r.error?.message}`);
    xs.push(performance.now() - t0);
  }
  return round(stats(xs));
};
results.toolLatencyMs = {
  'files.search (200 fichiers)': await toolLatency('files.search', () => ({
    root: t.workspace,
    pattern: '*.txt',
    maxResults: 500,
  })),
  'files.read': await toolLatency('files.read', (i) => ({ path: join(t.workspace, 'bench', `f${i}.txt`) })),
  'files.write (+ relecture)': await toolLatency('files.write', (i) => ({
    path: join(t.workspace, 'bench', `new${i}.txt`),
    content: 'x'.repeat(1000),
  })),
};
const mem = process.memoryUsage();
results.memoryMb = { rss: Math.round(mem.rss / 1e6), heapUsed: Math.round(mem.heapUsed / 1e6) };
await t.cleanup();

mkdirSync(join(root, 'test-results'), { recursive: true });
writeFileSync(join(root, 'test-results', 'bench.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));

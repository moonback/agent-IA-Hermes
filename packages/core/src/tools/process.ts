import { spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { z } from 'zod';
import { HermesError } from '../shared/errors';
import { assertInsideRoots } from '../policy-engine/paths';
import { alwaysAvailable, defineTool, type ToolContext } from './types';
import { KILL_GRACE_MS, spawnSandboxed, type SandboxReport } from './sandbox';

const WIN = process.platform === 'win32';
const OUTPUT_CAP = 200_000;
const running = new Set<ChildProcess>();

/** Environment passed to child processes: no secrets, only what common tools need to start. */
const ENV_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'HOME',
  'LANG',
];

export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && ENV_ALLOWLIST.includes(k.toUpperCase())) env[k] = v;
  }
  env.CI = '1';
  return env;
}

/** Resolves a command name to a real executable without going through a shell. */
export function resolveExecutable(name: string): { file: string; prefixArgs: string[] } {
  if (name === 'node') return { file: process.execPath, prefixArgs: [] };
  if (name === 'npm' || name === 'npx') {
    // npm.cmd needs a shell on Windows; run its JS entry point with node instead.
    const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', `${name}-cli.js`);
    if (!existsSync(cli))
      throw new HermesError('TOOL_UNAVAILABLE', `${name} introuvable à côté de node (${cli})`);
    return { file: process.execPath, prefixArgs: [cli] };
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, WIN ? `${name}.exe` : name);
    if (existsSync(candidate)) return { file: candidate, prefixArgs: [] };
  }
  throw new HermesError('TOOL_UNAVAILABLE', `Exécutable introuvable dans le PATH : ${name}`);
}

const GIT_FORBIDDEN =
  /^(-c|--config-env|--exec-path|--upload-pack|--receive-pack|-u|--exec|--git-dir|--work-tree)(=|$)|core\.(sshcommand|pager|editor|hookspath|fsmonitor)/i;

/** Hard refusals that no approval can override. */
export function validateCommand(command: string, args: string[]): void {
  for (const a of args) {
    if (a.includes('\0') || /[\r\n]/.test(a))
      throw new HermesError('POLICY_DENIED', 'Caractères de contrôle interdits dans les arguments');
  }
  if (command === 'git' && args.some((a) => GIT_FORBIDDEN.test(a))) {
    throw new HermesError('POLICY_DENIED', 'Option git permettant l’exécution de code arbitraire refusée');
  }
  if (
    (command === 'npm' || command === 'npx') &&
    args.some((a) => /^--(script-shell|prefix|userconfig|globalconfig)/.test(a))
  ) {
    throw new HermesError('POLICY_DENIED', 'Option npm refusée');
  }
}

/** Commands considered read-only or test-only; everything else needs a human approval. */
export function isSafeCommand(command: string, args: string[]): boolean {
  const [a0, a1] = args;
  if (args.length === 1 && (a0 === '--version' || a0 === '-v')) return true;
  if (command === 'git')
    return (
      ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files'].includes(a0 ?? '') ||
      (a0 === 'branch' && args.length <= 2 && !args.slice(1).some((x) => /^-[dDmM]/.test(x)))
    );
  if (command === 'npm')
    return (
      a0 === 'test' ||
      (a0 === 'run' && ['test', 'lint', 'typecheck', 'build'].includes(a1 ?? '') && args.length === 2)
    );
  return false;
}

/**
 * Stops a command: SIGTERM first (a real signal on POSIX; on Windows it ends hermes-jobrun, whose
 * Job Object then takes the whole tree down), then a forced tree kill after KILL_GRACE_MS.
 */
export function terminate(child: ChildProcess, graceMs = KILL_GRACE_MS): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const t = setTimeout(() => killTree(child), graceMs);
  t.unref();
  child.once('exit', () => clearTimeout(t));
}

export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGKILL');
}

/** Emergency stop: terminates every process started by process.run. */
export function killAllProcesses(): number {
  const n = running.size;
  for (const c of running) killTree(c);
  running.clear();
  return n;
}

const PROCESS_ENV_DENY =
  /^(PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|NODE_OPTIONS|NODE_PATH|LD_\w*|DYLD_\w*|GIT_\w*|NPM_CONFIG_\w*|PYTHON\w*|PERL5?LIB|PERL5OPT|RUBYOPT|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|PSMODULEPATH|PROMPT)$/i;
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION)/i;

/**
 * Validates a session variable: refuses names that change how programs are found or loaded
 * (PATH, NODE_OPTIONS, LD_PRELOAD, GIT_*…) and anything that looks like a secret.
 */
export function validateSessionVar(name: string, value?: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))
    throw new HermesError('VALIDATION', `Nom de variable invalide : ${name}`);
  if (PROCESS_ENV_DENY.test(name))
    throw new HermesError(
      'POLICY_DENIED',
      `Variable réservée (chargement ou recherche de programmes) : ${name}`,
    );
  if (SECRET_NAME.test(name))
    throw new HermesError('POLICY_DENIED', `Les secrets ne passent pas par shell.env : ${name}`);
  if (value !== undefined && (value.includes('\0') || value.length > 4096))
    throw new HermesError('VALIDATION', 'Valeur invalide (caractère nul ou plus de 4096 caractères)');
}

/** Child environment: allow-listed system variables, then the mission's session variables. */
export function missionEnv(ctx: Pick<ToolContext, 'missionId' | 'services'>): Record<string, string> {
  return { ...childEnv(), ...(ctx.services.sessionEnv.get(ctx.missionId) ?? {}) };
}

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  sandbox: SandboxReport;
}

const SandboxOut = z.object({
  kind: z.enum(['job-object', 'none']),
  reason: z.string().nullable(),
  limits: z.object({ memoryMb: z.number(), cpuPercent: z.number(), maxProcesses: z.number() }).nullable(),
  peakMemoryBytes: z.number().nullable(),
  cpuMs: z.number().nullable(),
  totalProcesses: z.number().nullable(),
  leftoverProcesses: z.number().nullable(),
  memoryLimitHit: z.boolean(),
});

const cap = (cur: { text: string; truncated: boolean }, chunk: Buffer) => {
  if (cur.text.length >= OUTPUT_CAP) return void (cur.truncated = true);
  const next = cur.text + chunk.toString('utf8');
  if (next.length > OUTPUT_CAP) cur.truncated = true;
  cur.text = next.slice(0, OUTPUT_CAP);
};

/**
 * Runs a chain of 1..N commands without any shell: stdout of each stage feeds stdin of the next.
 * Every stage is sandboxed. The chain succeeds only if every stage exits 0 (pipefail).
 */
export function runChain(
  stages: { file: string; args: string[] }[],
  o: {
    cwd: string;
    env: Record<string, string>;
    stdin?: string;
    timeoutSec: number;
    signal: AbortSignal;
    ctx: ToolContext;
  },
): Promise<
  RunResult & { stages: { exitCode: number | null; signal: string | null; sandbox: SandboxReport }[] }
> {
  const started = Date.now();
  const settings = o.ctx.services.sandbox();
  const procs = stages.map((s, i) =>
    spawnSandboxed(
      {
        file: s.file,
        args: s.args,
        cwd: o.cwd,
        env: o.env,
        stdin: i === 0 && o.stdin === undefined ? 'ignore' : 'pipe',
      },
      settings,
    ),
  );
  for (const p of procs) running.add(p.child);
  const stdout = { text: '', truncated: false };
  const stderr = { text: '', truncated: false };
  let timedOut = false;
  procs.forEach((p, i) => {
    const next = procs[i + 1];
    if (next) {
      p.child.stdout!.pipe(next.child.stdin!);
      // A consumer that exits early (head, findstr /m…) must not crash the producer.
      next.child.stdin!.on('error', () => undefined);
    } else p.child.stdout!.on('data', (c: Buffer) => cap(stdout, c));
    p.child.stderr!.on('data', (c: Buffer) =>
      cap(stderr, stages.length > 1 ? Buffer.from(`[${i + 1}] ${c.toString('utf8')}`) : c),
    );
  });
  if (o.stdin !== undefined) {
    procs[0]!.child.stdin!.on('error', () => undefined);
    procs[0]!.child.stdin!.end(o.stdin, 'utf8');
  }
  const stopAll = () => procs.forEach((p) => terminate(p.child));
  const timer = setTimeout(() => {
    timedOut = true;
    stopAll();
  }, o.timeoutSec * 1000);
  o.signal.addEventListener('abort', stopAll, { once: true });

  return new Promise((resolve, reject) => {
    const ends = procs.map(
      (p) =>
        new Promise<{ exitCode: number | null; signal: string | null }>((res, rej) => {
          p.child.on('error', (err) => {
            rej(new HermesError('TOOL_FAILED', `Démarrage impossible : ${err.message}`));
          });
          p.child.on('close', (code, sig) => {
            running.delete(p.child);
            res({ exitCode: code, signal: sig ?? null });
          });
        }),
    );
    Promise.all(ends)
      .then((results) => {
        const reports = procs.map((p) => p.report());
        const last = results.at(-1)!;
        const firstFailure = results.find((r) => r.exitCode !== 0);
        resolve({
          exitCode: firstFailure ? firstFailure.exitCode : last.exitCode,
          signal: firstFailure?.signal ?? last.signal,
          timedOut,
          stdout: stdout.text,
          stderr: stderr.text,
          truncated: stdout.truncated || stderr.truncated,
          durationMs: Date.now() - started,
          sandbox: reports[0]!,
          stages: results.map((r, i) => ({ ...r, sandbox: reports[i]! })),
        });
      })
      .catch((err: unknown) => {
        stopAll();
        reject(err);
      })
      .finally(() => {
        clearTimeout(timer);
        o.signal.removeEventListener('abort', stopAll);
      });
  });
}

/** Persisted audit line for every command: argv, exit code, duration, resources. */
function auditProcess(ctx: ToolContext, argv: string[][], r: RunResult) {
  const mem = r.sandbox.peakMemoryBytes;
  ctx.services.telemetry.record({
    missionId: ctx.missionId,
    taskId: ctx.taskId,
    agent: ctx.agent,
    toolId: argv.length > 1 ? 'shell.pipe' : 'process.run',
    category: 'tools',
    level: r.exitCode === 0 && !r.timedOut ? 'info' : 'warn',
    type: 'process.exited',
    message: `${argv.map((a) => a.join(' ')).join(' → ')} : code ${r.exitCode ?? 'aucun'}${r.timedOut ? ' (délai dépassé)' : ''}, ${r.durationMs} ms${mem !== null ? `, pic mémoire ${(mem / 1048576).toFixed(1)} Mo` : ''} [${r.sandbox.kind === 'job-object' ? 'Job Object' : 'sans bac à sable'}]`,
    data: { argv, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, sandbox: r.sandbox },
  });
}

export const processRun = defineTool({
  id: 'process.run',
  description:
    'Lance une commande autorisée (sans shell) avec des arguments séparés, dans un dossier autorisé. Retourne code de sortie, stdout et stderr (tronqués). Les commandes non en lecture seule demandent une approbation.',
  input: z.object({
    command: z.string().regex(/^[a-z0-9._-]{1,40}$/i),
    args: z.array(z.string().max(2000)).max(50).default([]),
    cwd: z.string().min(1).max(1024),
    timeoutSec: z.number().int().min(1).max(600).default(120),
  }),
  output: z.object({
    command: z.string(),
    args: z.array(z.string()),
    cwd: z.string(),
    exitCode: z.number().nullable(),
    signal: z.string().nullable(),
    timedOut: z.boolean(),
    stdout: z.string(),
    stderr: z.string(),
    truncated: z.boolean(),
    durationMs: z.number(),
    sandbox: SandboxOut,
  }),
  allowedAgents: ['code', 'shell'],
  permissions: ['process.spawn', 'fs.write'],
  risk: 'medium',
  timeoutMs: 610_000,
  reversible: false,
  idempotent: false,
  verification: 'Le code de sortie et les sorties réelles du processus sont capturés et enregistrés.',
  confirmation:
    'Approbation pour toute commande hors liste de lecture seule (git status/diff/log, npm test…).',
  availability: alwaysAvailable,
  resources: (i) => ({ command: i.command, paths: [{ path: i.cwd, access: 'write' }] }),
  approvalReason: (i) => {
    validateCommand(i.command, i.args);
    return isSafeCommand(i.command, i.args) ? null : `Exécution de « ${i.command} ${i.args.join(' ')} »`;
  },
  describe: (i) => ({
    description: `Exécuter : ${i.command} ${i.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')} (dans ${i.cwd})`,
    consequences:
      'La commande s’exécute avec vos droits utilisateur, dans un Job Object Windows (mémoire, CPU et nombre de processus limités ; tout le sous-arbre est arrêté à la fin) quand il est disponible. Pas d’isolation réseau ni des fichiers : elle peut modifier le dossier.',
  }),
  async run(i, ctx) {
    validateCommand(i.command, i.args);
    const cwd = assertInsideRoots(i.cwd, ctx.services.getPolicy().allowedRoots);
    const exe = resolveExecutable(i.command);
    const r = await runChain([{ file: exe.file, args: [...exe.prefixArgs, ...i.args] }], {
      cwd,
      env: missionEnv(ctx),
      timeoutSec: i.timeoutSec,
      signal: ctx.signal,
      ctx,
    });
    auditProcess(ctx, [[i.command, ...i.args]], r);
    return {
      command: i.command,
      args: i.args,
      cwd,
      exitCode: r.exitCode,
      signal: r.signal,
      timedOut: r.timedOut,
      stdout: r.stdout,
      stderr: r.stderr,
      truncated: r.truncated,
      durationMs: r.durationMs,
      sandbox: r.sandbox,
    };
  },
  async verify(_i, o) {
    return {
      verified: o.exitCode !== null && !o.timedOut,
      detail: o.timedOut
        ? 'Processus interrompu (délai dépassé)'
        : `Code de sortie observé : ${o.exitCode}${o.sandbox.memoryLimitHit ? ' (limite mémoire du bac à sable atteinte)' : ''}`,
    };
  },
});

const Stage = z.object({
  command: z.string().regex(/^[a-z0-9._-]{1,40}$/i),
  args: z.array(z.string().max(2000)).max(50).default([]),
});

export const shellPipe = defineTool({
  id: 'shell.pipe',
  description:
    'Enchaîne 2 à 5 commandes autorisées SANS shell : la sortie de chacune alimente l’entrée de la suivante (équivalent de a | b | c). Les caractères |, >, & ou $() dans les arguments restent littéraux. Échoue si une étape échoue.',
  input: z.object({
    stages: z.array(Stage).min(2).max(5),
    cwd: z.string().min(1).max(1024),
    stdin: z.string().max(100_000).optional(),
    timeoutSec: z.number().int().min(1).max(600).default(120),
  }),
  output: z.object({
    stages: z.array(
      z.object({
        command: z.string(),
        args: z.array(z.string()),
        exitCode: z.number().nullable(),
        signal: z.string().nullable(),
        sandbox: SandboxOut,
      }),
    ),
    exitCode: z.number().nullable(),
    timedOut: z.boolean(),
    stdout: z.string(),
    stderr: z.string(),
    truncated: z.boolean(),
    durationMs: z.number(),
  }),
  allowedAgents: ['shell'],
  permissions: ['process.spawn', 'fs.write'],
  risk: 'medium',
  timeoutMs: 610_000,
  reversible: false,
  idempotent: false,
  verification: 'Codes de sortie réels de chaque étape (échec si l’une échoue), sorties capturées.',
  confirmation: 'Approbation dès qu’une étape n’est pas en lecture seule.',
  availability: alwaysAvailable,
  resources: (i) => ({ commands: i.stages.map((s) => s.command), paths: [{ path: i.cwd, access: 'write' }] }),
  approvalReason: (i) => {
    for (const s of i.stages) validateCommand(s.command, s.args);
    const unsafe = i.stages.filter((s) => !isSafeCommand(s.command, s.args));
    return unsafe.length
      ? `Pipeline avec ${unsafe.map((s) => `« ${s.command} ${s.args.join(' ')} »`).join(', ')}`
      : null;
  },
  describe: (i) => ({
    description: `Pipeline : ${i.stages.map((s) => [s.command, ...s.args].join(' ')).join(' | ')} (dans ${i.cwd})`,
    consequences:
      'Chaque commande s’exécute avec vos droits utilisateur, dans un Job Object Windows quand il est disponible. Elles peuvent modifier des fichiers du dossier.',
  }),
  async run(i, ctx) {
    for (const s of i.stages) validateCommand(s.command, s.args);
    const cwd = assertInsideRoots(i.cwd, ctx.services.getPolicy().allowedRoots);
    const exes = i.stages.map((s) => {
      const exe = resolveExecutable(s.command);
      return { file: exe.file, args: [...exe.prefixArgs, ...s.args] };
    });
    const r = await runChain(exes, {
      cwd,
      env: missionEnv(ctx),
      stdin: i.stdin,
      timeoutSec: i.timeoutSec,
      signal: ctx.signal,
      ctx,
    });
    auditProcess(
      ctx,
      i.stages.map((s) => [s.command, ...s.args]),
      r,
    );
    return {
      stages: i.stages.map((s, n) => ({ command: s.command, args: s.args, ...r.stages[n]! })),
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      stdout: r.stdout,
      stderr: r.stderr,
      truncated: r.truncated,
      durationMs: r.durationMs,
    };
  },
  async verify(_i, o) {
    const failed = o.stages.findIndex((s) => s.exitCode !== 0);
    return {
      verified: !o.timedOut && failed < 0,
      detail: o.timedOut
        ? 'Pipeline interrompu (délai dépassé)'
        : failed >= 0
          ? `Étape ${failed + 1} (${o.stages[failed]!.command}) : code ${o.stages[failed]!.exitCode}`
          : `${o.stages.length} étapes terminées avec le code 0`,
    };
  },
});

export const shellEnv = defineTool({
  id: 'shell.env',
  description:
    'Variables d’environnement propres à la mission, transmises à process.run et shell.pipe : set, unset ou list. Refusé pour les secrets et les variables qui changent le chargement des programmes (PATH, NODE_OPTIONS, GIT_*…).',
  input: z.discriminatedUnion('action', [
    z.object({ action: z.literal('set'), name: z.string().max(64), value: z.string().max(4096) }),
    z.object({ action: z.literal('unset'), name: z.string().max(64) }),
    z.object({ action: z.literal('list') }),
  ]),
  output: z.object({ variables: z.record(z.string(), z.string()) }),
  allowedAgents: ['shell'],
  permissions: ['process.env'],
  risk: 'low',
  timeoutMs: 5_000,
  reversible: true,
  idempotent: true,
  verification: 'Les variables de la mission sont relues après modification.',
  confirmation: 'Aucune (variables limitées à la mission, jamais de secret).',
  availability: alwaysAvailable,
  resources: () => ({}),
  async run(i, ctx) {
    const vars = { ...(ctx.services.sessionEnv.get(ctx.missionId) ?? {}) };
    if (i.action === 'set') {
      validateSessionVar(i.name, i.value);
      vars[i.name] = i.value;
    } else if (i.action === 'unset') delete vars[i.name];
    ctx.services.sessionEnv.set(ctx.missionId, vars);
    return { variables: vars };
  },
  async verify(i, o, ctx) {
    const cur = ctx.services.sessionEnv.get(ctx.missionId) ?? {};
    return {
      verified: JSON.stringify(cur) === JSON.stringify(o.variables),
      detail: `${Object.keys(cur).length} variable(s) de mission`,
    };
  },
});

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { z } from 'zod';
import { HermesError } from '../shared/errors';
import { assertInsideRoots } from '../policy-engine/paths';
import { alwaysAvailable, defineTool } from './types';

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
  }),
  allowedAgents: ['code'],
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
      'La commande s’exécute avec vos droits utilisateur (pas d’isolation réseau ni mémoire stricte sous Windows). Elle peut modifier des fichiers du dossier.',
  }),
  async run(i, ctx) {
    validateCommand(i.command, i.args);
    const cwd = assertInsideRoots(i.cwd, ctx.services.getPolicy().allowedRoots);
    const exe = resolveExecutable(i.command);
    const started = Date.now();
    return await new Promise((resolve, reject) => {
      const child = spawn(exe.file, [...exe.prefixArgs, ...i.args], {
        cwd,
        env: childEnv(),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      running.add(child);
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      const cap = (cur: string, chunk: Buffer) => {
        if (cur.length >= OUTPUT_CAP) {
          truncated = true;
          return cur;
        }
        const next = cur + chunk.toString('utf8');
        if (next.length > OUTPUT_CAP) truncated = true;
        return next.slice(0, OUTPUT_CAP);
      };
      child.stdout.on('data', (c: Buffer) => (stdout = cap(stdout, c)));
      child.stderr.on('data', (c: Buffer) => (stderr = cap(stderr, c)));
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, i.timeoutSec * 1000);
      const onAbort = () => killTree(child);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (err) => {
        clearTimeout(timer);
        running.delete(child);
        reject(new HermesError('TOOL_FAILED', `Démarrage impossible : ${err.message}`));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        running.delete(child);
        ctx.signal.removeEventListener('abort', onAbort);
        resolve({
          command: i.command,
          args: i.args,
          cwd,
          exitCode: code,
          signal: signal ?? null,
          timedOut,
          stdout,
          stderr,
          truncated,
          durationMs: Date.now() - started,
        });
      });
    });
  },
  async verify(_i, o) {
    return {
      verified: o.exitCode !== null && !o.timedOut,
      detail: o.timedOut ? 'Processus interrompu (délai dépassé)' : `Code de sortie observé : ${o.exitCode}`,
    };
  },
});

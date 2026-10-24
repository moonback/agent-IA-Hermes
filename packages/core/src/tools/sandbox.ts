import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defaultWorkersDir } from './desktop';

/**
 * Process sandbox. On Windows every command runs through `hermes-jobrun`, which places it in a Job
 * Object (memory, CPU and process-count limits; the whole tree dies with the job) and reports
 * resource usage. Elsewhere, or when the helper is missing, commands run unconfined and the
 * result says so: the sandbox is never claimed when it is not there.
 */

export const SandboxSettings = z.object({
  enabled: z.boolean().default(true),
  memoryMb: z.number().int().min(64).max(65_536).default(2_048),
  cpuPercent: z.number().int().min(5).max(100).default(80),
  maxProcesses: z.number().int().min(1).max(512).default(64),
});
export type SandboxSettings = z.infer<typeof SandboxSettings>;

export interface SandboxReport {
  kind: 'job-object' | 'none';
  reason: string | null;
  limits: { memoryMb: number; cpuPercent: number; maxProcesses: number } | null;
  peakMemoryBytes: number | null;
  cpuMs: number | null;
  totalProcesses: number | null;
  /** Descendants still alive when the command ended (killed with the job). */
  leftoverProcesses: number | null;
  memoryLimitHit: boolean;
}

/** Grace period between the polite stop request and the forced kill. */
export const KILL_GRACE_MS = 2_000;

export function jobRunnerPath(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string | null {
  if (platform !== 'win32') return null;
  const candidates = [
    env.HERMES_JOBRUN_PATH,
    join(defaultWorkersDir(), 'bin', 'hermes-jobrun.exe'),
    join(defaultWorkersDir(), 'jobrun', 'target', 'release', 'hermes-jobrun.exe'),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? null;
}

export interface SpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: 'ignore' | 'pipe';
}

export interface SandboxedChild {
  child: ChildProcess;
  /** Reads the helper's statistics once the process has exited. */
  report(): SandboxReport;
}

const unconfined = (reason: string): SandboxReport => ({
  kind: 'none',
  reason,
  limits: null,
  peakMemoryBytes: null,
  cpuMs: null,
  totalProcesses: null,
  leftoverProcesses: null,
  memoryLimitHit: false,
});

export function spawnSandboxed(
  spec: SpawnSpec,
  settings: SandboxSettings,
  opts: { runner?: string | null } = {},
): SandboxedChild {
  const runner = opts.runner === undefined ? jobRunnerPath() : opts.runner;
  const base = { cwd: spec.cwd, env: spec.env, shell: false, windowsHide: true } as const;
  const stdio = [spec.stdin, 'pipe', 'pipe'] as const;
  if (!settings.enabled || !runner) {
    const reason = !settings.enabled
      ? 'bac à sable désactivé dans les paramètres'
      : process.platform === 'win32'
        ? 'utilitaire hermes-jobrun introuvable'
        : 'Job Objects disponibles sous Windows uniquement';
    const child = spawn(spec.file, spec.args, { ...base, stdio: [...stdio] });
    return { child, report: () => unconfined(reason) };
  }
  const statsPath = join(tmpdir(), `hermes-job-${randomUUID()}.json`);
  const limits = {
    memoryMb: settings.memoryMb,
    cpuPercent: settings.cpuPercent,
    maxProcesses: settings.maxProcesses,
  };
  const child = spawn(
    runner,
    [
      '--memory-mb',
      String(limits.memoryMb),
      '--cpu-percent',
      String(limits.cpuPercent),
      '--max-processes',
      String(limits.maxProcesses),
      '--stats',
      statsPath,
      '--',
      spec.file,
      ...spec.args,
    ],
    { ...base, stdio: [...stdio] },
  );
  return {
    child,
    report: () => {
      try {
        const s = JSON.parse(readFileSync(statsPath, 'utf8')) as Record<string, unknown>;
        const n = (k: string) => (typeof s[k] === 'number' ? (s[k] as number) : null);
        return {
          kind: 'job-object',
          reason: null,
          limits,
          peakMemoryBytes: n('peakJobMemoryBytes'),
          cpuMs: (n('userMs') ?? 0) + (n('kernelMs') ?? 0),
          totalProcesses: n('totalProcesses'),
          leftoverProcesses: n('activeProcessesAtExit'),
          memoryLimitHit: s.memoryLimitHit === true,
        };
      } catch {
        // Killed before writing statistics (timeout, cancellation): limits applied, usage unknown.
        return {
          ...unconfined('statistiques indisponibles (processus interrompu)'),
          kind: 'job-object',
          limits,
        };
      } finally {
        rmSync(statsPath, { force: true });
      }
    },
  };
}

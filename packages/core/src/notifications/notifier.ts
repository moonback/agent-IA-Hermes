import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger, Telemetry } from '../observability/telemetry';
import { defaultWorkersDir } from '../tools/desktop';

export interface Notification {
  title: string;
  body: string;
  level?: 'info' | 'success' | 'warn' | 'error';
  missionId?: string | null;
}

export interface Notifier {
  notify(n: Notification): void;
}

/**
 * In-app notice (live 'notification' event, always) and, on Windows when enabled, a toast shown by a
 * short-lived PowerShell process. Title and body travel in environment variables, never on the
 * command line, so nothing in them can be interpreted as script.
 */
export class DesktopNotifier implements Notifier {
  private readonly script: string;
  private toastFailures = 0;

  constructor(
    private readonly deps: {
      telemetry: Telemetry;
      logger: Logger;
      desktopEnabled: () => boolean;
      platform?: NodeJS.Platform;
      workersDir?: string;
    },
  ) {
    this.script = join(deps.workersDir ?? defaultWorkersDir(), 'desktop-windows', 'toast.ps1');
  }

  notify(n: Notification): void {
    const title = n.title.slice(0, 120);
    const body = n.body.slice(0, 400);
    this.deps.telemetry.live({
      type: 'notification',
      category: 'notification',
      missionId: n.missionId ?? null,
      data: { title, body, level: n.level ?? 'info' },
    });
    if ((this.deps.platform ?? process.platform) !== 'win32' || !this.deps.desktopEnabled()) return;
    // After repeated failures (no toast support, policy), stop spawning PowerShell for nothing.
    if (this.toastFailures >= 3 || !existsSync(this.script)) return;
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script],
        {
          windowsHide: true,
          stdio: 'ignore',
          env: { ...process.env, HERMES_TOAST_TITLE: title, HERMES_TOAST_BODY: body },
        },
      );
      const timer = setTimeout(() => child.kill(), 15_000);
      child.on('error', () => this.failed('powershell.exe introuvable'));
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) this.failed(`code ${code}`);
        else this.toastFailures = 0;
      });
    } catch (err) {
      this.failed(String(err));
    }
  }

  private failed(reason: string) {
    this.toastFailures++;
    this.deps.logger.log({
      level: 'warn',
      category: 'application',
      message: `Notification Windows impossible : ${reason}`,
    });
  }
}

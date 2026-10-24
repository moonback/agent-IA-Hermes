import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EventCategory, LogLevel, MissionEvent } from '../shared/contracts';
import { redact } from '../shared/redact';
import type { HermesStore, NewEvent } from '../persistence/store';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  ts: string;
  level: LogLevel;
  category: EventCategory;
  message: string;
  missionId?: string | null;
  taskId?: string | null;
  agent?: string | null;
  toolId?: string | null;
  errorCode?: string | null;
  data?: unknown;
}

/** JSON-lines file logger with secret masking and an in-memory ring buffer for diagnostics. */
export class Logger {
  private readonly ring: LogEntry[] = [];

  constructor(
    private readonly opts: { dir?: string; minLevel?: LogLevel; ringSize?: number; console?: boolean } = {},
  ) {
    if (opts.dir) mkdirSync(opts.dir, { recursive: true });
  }

  log(entry: Omit<LogEntry, 'ts'>): void {
    if (LEVELS[entry.level] < LEVELS[this.opts.minLevel ?? 'info']) return;
    const e: LogEntry = redact({ ts: new Date().toISOString(), ...entry });
    this.ring.push(e);
    if (this.ring.length > (this.opts.ringSize ?? 1000)) this.ring.shift();
    const line = JSON.stringify(e);
    if (this.opts.dir) {
      try {
        appendFileSync(join(this.opts.dir, `hermes-${e.ts.slice(0, 10)}.log`), `${line}\n`);
      } catch (err) {
        // Logging must never crash the app, but the failure is surfaced on stderr.
        process.stderr.write(`[hermes] écriture du log impossible : ${String(err)}\n`);
      }
    }
    if (this.opts.console) process.stderr.write(`${line}\n`);
  }

  recent(limit = 200, minLevel: LogLevel = 'debug'): LogEntry[] {
    return this.ring.filter((e) => LEVELS[e.level] >= LEVELS[minLevel]).slice(-limit);
  }
}

export interface LiveEvent {
  type: string;
  missionId?: string | null;
  taskId?: string | null;
  agent?: string | null;
  data?: unknown;
}

/**
 * Single entry point for observable events: persisted audit events (`event`) and
 * ephemeral live updates such as streamed tokens (`live`, never persisted).
 */
export class Telemetry extends EventEmitter<{ event: [MissionEvent]; live: [LiveEvent] }> {
  constructor(
    readonly store: HermesStore,
    readonly logger: Logger,
  ) {
    super();
    this.setMaxListeners(100);
  }

  record(e: NewEvent): MissionEvent {
    const ev = this.store.appendEvent(e);
    this.logger.log({
      level: ev.level,
      category: ev.category,
      message: `${ev.type}: ${ev.message}`,
      missionId: ev.missionId,
      taskId: ev.taskId,
      agent: ev.agent,
      toolId: ev.toolId,
      errorCode: ev.errorCode,
    });
    this.emit('event', ev);
    return ev;
  }

  live(e: LiveEvent): void {
    this.emit('live', redact(e));
  }
}

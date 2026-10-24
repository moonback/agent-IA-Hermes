import { join } from 'node:path';
import { MemorySecretStore, createRuntime, errorMessage } from '@hermes/core';
import { createHttpServer } from './http';
import { buildRoutes } from './routes';

const VERSION = '0.1.0';
const t0 = Date.now();

const token = process.env.HERMES_TOKEN;
if (!token || token.length < 32) {
  process.stderr.write(
    'HERMES_TOKEN (≥ 32 caractères) est requis : lancez HERMES via l’application ou `pnpm dev`.\n',
  );
  process.exit(2);
}

const dataDir = process.env.HERMES_DATA_DIR ?? join(process.env.APPDATA ?? process.env.HOME ?? '.', 'hermes');
const allowedOrigins = (
  process.env.HERMES_ALLOWED_ORIGINS ??
  'http://localhost:1420,http://127.0.0.1:1420,tauri://localhost,http://tauri.localhost,https://tauri.localhost'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Test-only switches (automated end-to-end tests): never set them in normal use.
const testMode = process.env.HERMES_TEST_MODE === '1';
const rt = await createRuntime({
  dataDir,
  secrets: testMode ? new MemorySecretStore() : undefined,
  allowLoopbackProviderForTests: testMode,
  logToConsole: process.env.HERMES_LOG_CONSOLE === '1',
});
if (testMode) {
  rt.telemetry.record({
    category: 'security',
    level: 'warn',
    type: 'app.test_mode',
    message: 'Mode test : coffre en mémoire et fournisseur local autorisé',
  });
}

const server = createHttpServer(buildRoutes(rt, { version: VERSION, startupMs: Date.now() - t0 }), {
  token,
  allowedOrigins,
  onError: (err) =>
    rt.logger.log({ level: 'error', category: 'application', message: `Erreur API : ${errorMessage(err)}` }),
});

server.listen(Number(process.env.HERMES_PORT ?? 0), '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  // Parsed by the Tauri shell and the dev launcher; never contains the token.
  process.stdout.write(`HERMES_READY port=${port} startupMs=${Date.now() - t0}\n`);
});

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  rt.telemetry.record({
    category: 'application',
    type: 'app.stopping',
    message: `Arrêt du serveur (${signal})`,
  });
  server.close();
  await rt.close().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// The Tauri shell keeps our stdin open and closes it when it exits: never outlive the desktop app.
if (process.env.HERMES_EXIT_ON_STDIN_CLOSE === '1') {
  process.stdin.on('end', () => void shutdown('stdin-closed'));
  process.stdin.resume();
}

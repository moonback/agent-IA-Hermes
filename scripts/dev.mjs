// Development launcher: starts the local HERMES service, waits for its port, then Vite with a proxy.
// The session token is generated here and only passed through environment variables.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const env = { ...process.env };
// Optional .env for development (OPENROUTER_API_KEY, HERMES_DATA_DIR…). Never committed.
const dotenv = join(root, '.env');
if (existsSync(dotenv)) {
  for (const line of readFileSync(dotenv, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[2] && !env[m[1]]) env[m[1]] = m[2];
  }
}
env.HERMES_TOKEN = randomBytes(32).toString('hex');

const children = [];
const stopAll = () => children.forEach((c) => c.exitCode === null && c.kill());
process.on('SIGINT', () => (stopAll(), process.exit(0)));

const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const server = spawn(process.execPath, [tsx, join(root, 'apps/server/src/main.ts')], {
  env,
  stdio: ['ignore', 'pipe', 'inherit'],
});
children.push(server);
server.on('exit', (code) => {
  console.error(`[dev] service HERMES arrêté (code ${code})`);
  stopAll();
  process.exit(code ?? 1);
});

server.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  const m = /HERMES_READY port=(\d+)/.exec(text);
  if (m && children.length === 1) {
    const vite = spawn(process.execPath, [join(root, 'apps/desktop/node_modules/vite/bin/vite.js')], {
      cwd: join(root, 'apps/desktop'),
      env: { ...env, HERMES_API_URL: `http://127.0.0.1:${m[1]}` },
      stdio: 'inherit',
    });
    children.push(vite);
    vite.on('exit', () => (stopAll(), process.exit(0)));
  }
});

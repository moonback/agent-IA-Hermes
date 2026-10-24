// Bundles the local service into dist/hermes-server.mjs for the desktop installer.
// Native/asset-heavy packages stay external and are copied (dereferenced) next to the bundle.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const here = import.meta.dirname;
const dist = join(here, 'dist');
const external = ['playwright', 'playwright-core', '@napi-rs/keyring'];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(here, 'src/main.ts')],
  outfile: join(dist, 'hermes-server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external,
  // CommonJS dependencies inside an ESM bundle need a real require().
  banner: {
    js: "import { createRequire as __hermesCreateRequire } from 'node:module'; const require = __hermesCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});

// Copy runtime dependencies resolved from @hermes/core (pnpm symlinks are dereferenced).
const coreRequire = createRequire(join(here, '../../packages/core/src/index.ts'));
const pkgDir = (name, req = coreRequire) => dirname(realpathSync(req.resolve(`${name}/package.json`)));
const copy = (name, from) =>
  cpSync(from, join(dist, 'node_modules', name), { recursive: true, dereference: true });

const playwright = pkgDir('playwright');
copy('playwright', playwright);
copy('playwright-core', pkgDir('playwright-core', createRequire(join(playwright, 'package.json'))));
const keyring = pkgDir('@napi-rs/keyring');
copy('@napi-rs/keyring', keyring);
const keyringRequire = createRequire(join(keyring, 'package.json'));
for (const native of ['@napi-rs/keyring-win32-x64-msvc', '@napi-rs/keyring-win32-arm64-msvc']) {
  try {
    copy(native, pkgDir(native, keyringRequire));
  } catch {
    // optional platform binary not installed on this machine
  }
}
writeFileSync(
  join(dist, 'package.json'),
  JSON.stringify({ name: 'hermes-server-bundle', private: true, type: 'module' }, null, 2),
);
console.log(`Service empaqueté dans ${dist}`);

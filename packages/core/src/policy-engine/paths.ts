import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HermesError } from '../shared/errors';

const WIN = process.platform === 'win32';

/**
 * Turns a user/model supplied path into a canonical absolute path, resolving symlinks and
 * junctions of the deepest existing ancestor so a link cannot be used to escape a root.
 */
export function canonicalize(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 1024) {
    throw new HermesError('VALIDATION', 'Chemin vide ou trop long');
  }
  if (input.includes('\0')) throw new HermesError('VALIDATION', 'Caractère nul interdit dans un chemin');
  if (WIN) {
    if (/^\\\\[?.]\\/.test(input))
      throw new HermesError('POLICY_DENIED', 'Chemins de périphérique Windows interdits');
    if (/^(\\\\|\/\/)/.test(input)) throw new HermesError('POLICY_DENIED', 'Chemins réseau (UNC) interdits');
    // A colon is only legal right after the drive letter; anything else is an alternate data stream.
    if (input.slice(2).includes(':'))
      throw new HermesError('POLICY_DENIED', 'Flux de données alternatifs interdits');
    const reserved = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
    if (input.split(/[\\/]/).some((seg) => reserved.test(seg)))
      throw new HermesError('POLICY_DENIED', 'Nom de périphérique réservé');
  }
  if (!isAbsolute(input)) throw new HermesError('VALIDATION', `Le chemin doit être absolu : ${input}`);
  const abs = resolve(input);
  let existing = abs;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  const real = existsSync(existing) ? realpathSync.native(existing) : existing;
  return rest.length ? join(real, ...rest) : real;
}

export function isWithin(root: string, target: string): boolean {
  const r = WIN ? root.toLowerCase() : root;
  const t = WIN ? target.toLowerCase() : target;
  if (r === t) return true;
  const rel = relative(r, t);
  return rel !== '' && !isAbsolute(rel) && rel.split(sep)[0] !== '..';
}

/** Returns the canonical path if it lies inside one of the canonical roots, otherwise throws. */
export function assertInsideRoots(input: string, roots: string[]): string {
  const p = canonicalize(input);
  const canonicalRoots = roots.map((r) => canonicalize(r));
  if (!canonicalRoots.some((r) => isWithin(r, p))) {
    throw new HermesError('POLICY_DENIED', `Chemin hors des dossiers autorisés : ${p}`);
  }
  return p;
}

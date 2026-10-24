import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  APP_THEMES,
  DEFAULT_THEME,
  THEME_INFO,
  THEME_STORAGE_KEY,
  applyTheme,
  parseTheme,
  readStoredTheme,
  storeTheme,
  type KeyValueStorage,
} from '../../apps/desktop/src/theme';

const memoryStorage = (
  init: Record<string, string> = {},
): KeyValueStorage & { data: Record<string, string> } => {
  const data = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
};

const throwingStorage: KeyValueStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('thème de l’interface', () => {
  it('propose exactement les trois thèmes Glass, avec Glass Dark par défaut', () => {
    expect(APP_THEMES).toEqual(['glass-dark', 'glass-light', 'glass-cyberpunk']);
    expect(DEFAULT_THEME).toBe('glass-dark');
    expect(Object.keys(THEME_INFO).sort()).toEqual([...APP_THEMES].sort());
  });

  it('utilise le thème par défaut sans préférence enregistrée', () => {
    expect(readStoredTheme(memoryStorage())).toBe('glass-dark');
    expect(readStoredTheme(null)).toBe('glass-dark');
  });

  it('accepte chacun des trois thèmes', () => {
    for (const t of APP_THEMES) expect(parseTheme(t)).toBe(t);
  });

  it('retombe sur un thème valide pour une valeur invalide', () => {
    for (const v of ['', 'GLASS-DARK', 'glass-neon', '{"theme":1}', null, undefined, 42, {}]) {
      expect(parseTheme(v)).toBe('glass-dark');
    }
  });

  it('migre l’ancienne préférence clair / sombre', () => {
    expect(parseTheme('light')).toBe('glass-light');
    expect(parseTheme('dark')).toBe('glass-dark');
  });

  it('persiste le thème choisi et le relit au redémarrage', () => {
    const storage = memoryStorage();
    storeTheme(storage, 'glass-cyberpunk');
    expect(storage.data[THEME_STORAGE_KEY]).toBe('glass-cyberpunk');
    expect(readStoredTheme(storage)).toBe('glass-cyberpunk');
  });

  it('reste utilisable si le stockage est indisponible', () => {
    expect(readStoredTheme(throwingStorage)).toBe('glass-dark');
    expect(() => storeTheme(throwingStorage, 'glass-light')).not.toThrow();
  });

  it('applique le thème et le schéma de couleurs à la racine', () => {
    const root = { dataset: {} as Record<string, string | undefined>, style: { colorScheme: '' } };
    applyTheme(root, 'glass-light');
    expect(root).toEqual({ dataset: { theme: 'glass-light' }, style: { colorScheme: 'light' } });
    applyTheme(root, 'glass-cyberpunk');
    expect(root).toEqual({ dataset: { theme: 'glass-cyberpunk' }, style: { colorScheme: 'dark' } });
  });

  it('le script de démarrage (anti-flash) interprète les valeurs comme parseTheme', () => {
    const script = readFileSync(join(import.meta.dirname, '../../apps/desktop/public/theme-boot.js'), 'utf8');
    const run = (stored: Record<string, string> | 'throw') => {
      const root = { dataset: {} as Record<string, string>, style: { colorScheme: '' } };
      const localStorage = stored === 'throw' ? throwingStorage : memoryStorage(stored);
      runInNewContext(script, { document: { documentElement: root }, localStorage });
      return root;
    };
    for (const v of [...APP_THEMES, 'light', 'dark', 'invalid', '__proto__', 'toString', '']) {
      const root = run({ [THEME_STORAGE_KEY]: v });
      expect(root.dataset.theme).toBe(parseTheme(v));
      expect(root.style.colorScheme).toBe(THEME_INFO[parseTheme(v)].scheme);
    }
    expect(run({}).dataset.theme).toBe('glass-dark');
    expect(run('throw').dataset.theme).toBe('glass-dark');
    expect(run({ 'hermes.reducedTransparency': '1' }).dataset.transparency).toBe('reduced');
    expect(run({}).dataset.transparency).toBeUndefined();
  });
});

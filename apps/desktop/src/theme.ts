// Appearance preference only: it never touches permissions, tools or security policy.
// Kept free of DOM globals so it can be unit-tested in the Node test environment.

export const APP_THEMES = ['glass-dark', 'glass-light', 'glass-cyberpunk'] as const;
export type AppTheme = (typeof APP_THEMES)[number];

export const DEFAULT_THEME: AppTheme = 'glass-dark';
/** Same key as the previous dark/light toggle, so existing preferences carry over. */
export const THEME_STORAGE_KEY = 'hermes.theme';

export const THEME_INFO: Record<AppTheme, { name: string; description: string; scheme: 'dark' | 'light' }> = {
  'glass-dark': {
    name: 'Glass Dark',
    description: 'Verre bleu nuit, accents bleu électrique. Sobre et contrasté pour le travail quotidien.',
    scheme: 'dark',
  },
  'glass-light': {
    name: 'Glass Light',
    description: 'Verre blanc lumineux sur fond glacier, accents bleu et violet. Aéré et très lisible.',
    scheme: 'light',
  },
  'glass-cyberpunk': {
    name: 'Glass Cyberpunk',
    description: 'Noir bleuté, néons cyan, violet et magenta réservés aux éléments actifs.',
    scheme: 'dark',
  },
};

export const isAppTheme = (v: unknown): v is AppTheme =>
  typeof v === 'string' && (APP_THEMES as readonly string[]).includes(v);

/** Accepts current values and the legacy 'dark' / 'light' values; anything else falls back to the default. */
export function parseTheme(v: unknown): AppTheme {
  if (isAppTheme(v)) return v;
  if (v === 'light') return 'glass-light';
  return DEFAULT_THEME;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Storage can be missing or throw (private mode, blocked site data): the preference is then simply not kept. */
export function readStoredTheme(storage: KeyValueStorage | null | undefined): AppTheme {
  try {
    return parseTheme(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function storeTheme(storage: KeyValueStorage | null | undefined, theme: AppTheme): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* preference only */
  }
}

export interface ThemeRoot {
  dataset: Record<string, string | undefined>;
  style: { colorScheme: string };
}

export function applyTheme(root: ThemeRoot, theme: AppTheme): void {
  root.dataset.theme = theme;
  root.style.colorScheme = THEME_INFO[theme].scheme;
}

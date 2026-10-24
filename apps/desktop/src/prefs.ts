import { create } from 'zustand';
import { applyTheme, readStoredTheme, storeTheme, type AppTheme } from './theme';

// Interface preferences, kept per machine in localStorage like the previous theme toggle.
// None of them changes what HERMES is allowed to do.

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const readFlag = (key: string, fallback: boolean): boolean => {
  try {
    const v = storage()?.getItem(key);
    return v === '1' ? true : v === '0' ? false : fallback;
  } catch {
    return fallback;
  }
};

const writeFlag = (key: string, on: boolean) => {
  try {
    storage()?.setItem(key, on ? '1' : '0');
  } catch {
    /* preference only */
  }
};

const KEYS = {
  sidebar: 'hermes.sidebarCollapsed',
  activity: 'hermes.activityPanel',
  transparency: 'hermes.reducedTransparency',
} as const;

interface PrefsState {
  theme: AppTheme;
  sidebarCollapsed: boolean;
  activityPanel: boolean;
  reducedTransparency: boolean;
  setTheme: (theme: AppTheme) => void;
  toggleSidebar: () => void;
  toggleActivityPanel: () => void;
  setReducedTransparency: (on: boolean) => void;
}

let switchTimer: number | undefined;

export const usePrefs = create<PrefsState>((set, get) => ({
  theme: readStoredTheme(storage()),
  sidebarCollapsed: readFlag(KEYS.sidebar, false),
  activityPanel: readFlag(KEYS.activity, true),
  reducedTransparency: readFlag(KEYS.transparency, false),
  setTheme: (theme) => {
    if (theme === get().theme) return;
    storeTheme(storage(), theme);
    // Colours cross-fade only during the switch, so normal hover feedback stays instantaneous.
    const root = document.documentElement;
    root.classList.add('theme-switching');
    window.clearTimeout(switchTimer);
    switchTimer = window.setTimeout(() => root.classList.remove('theme-switching'), 320);
    applyTheme(root, theme);
    set({ theme });
  },
  toggleSidebar: () => {
    const sidebarCollapsed = !get().sidebarCollapsed;
    writeFlag(KEYS.sidebar, sidebarCollapsed);
    set({ sidebarCollapsed });
  },
  toggleActivityPanel: () => {
    const activityPanel = !get().activityPanel;
    writeFlag(KEYS.activity, activityPanel);
    set({ activityPanel });
  },
  setReducedTransparency: (reducedTransparency) => {
    writeFlag(KEYS.transparency, reducedTransparency);
    set({ reducedTransparency });
  },
}));

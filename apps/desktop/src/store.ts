import { create } from 'zustand';
import { subscribe } from './api';
import type { LiveEvent, MissionEvent } from './types';

export type Page =
  | 'dashboard'
  | 'chat'
  | 'voice'
  | 'missions'
  | 'schedule'
  | 'computer'
  | 'agents'
  | 'models'
  | 'tools'
  | 'history'
  | 'settings';

interface StreamText {
  agent: string | null;
  text: string;
  done: boolean;
}

export interface AppNotification {
  id: number;
  title: string;
  body: string;
  level: 'info' | 'success' | 'warn' | 'error';
  missionId: string | null;
}

interface AppState {
  page: Page;
  selectedMissionId: string | null;
  connected: boolean;
  events: MissionEvent[];
  /** Streamed model output per mission (latest agent call only), never persisted. */
  streams: Record<string, StreamText>;
  /** Incremented on every persisted event: hooks refetch when it changes. */
  revision: number;
  /** Notices sent by the server (proactive missions), shown as in-app toasts. */
  notifications: AppNotification[];
  dismissNotification: (id: number) => void;
  navigate: (page: Page, missionId?: string | null) => void;
  start: () => () => void;
}

let notificationSeq = 0;

export const useApp = create<AppState>((set, get) => ({
  page: 'dashboard',
  selectedMissionId: null,
  connected: false,
  events: [],
  streams: {},
  revision: 0,
  notifications: [],
  dismissNotification: (id) => set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
  navigate: (page, missionId) =>
    set({ page, selectedMissionId: missionId === undefined ? get().selectedMissionId : missionId }),
  start: () =>
    subscribe(
      ({ event, data }) => {
        if (event === 'event') {
          const e = data as MissionEvent;
          set((s) => ({ events: [...s.events.slice(-499), e], revision: s.revision + 1 }));
        } else if (event === 'live') {
          const e = data as LiveEvent;
          if (e.type === 'notification') {
            const d = (e.data ?? {}) as Partial<AppNotification>;
            const n: AppNotification = {
              id: ++notificationSeq,
              title: String(d.title ?? 'HERMES'),
              body: String(d.body ?? ''),
              level: d.level ?? 'info',
              missionId: e.missionId ?? null,
            };
            set((s) => ({ notifications: [...s.notifications.slice(-3), n] }));
            return;
          }
          if (!e.missionId) return;
          const id = e.missionId;
          set((s) => {
            const cur = s.streams[id];
            if (e.type === 'llm.start')
              return { streams: { ...s.streams, [id]: { agent: e.agent ?? null, text: '', done: false } } };
            if (e.type === 'llm.retry')
              return { streams: { ...s.streams, [id]: { agent: e.agent ?? null, text: '', done: false } } };
            if (e.type === 'llm.delta' && cur)
              return {
                streams: {
                  ...s.streams,
                  [id]: {
                    ...cur,
                    text: (cur.text + String((e.data as { text?: string })?.text ?? '')).slice(-20000),
                  },
                },
              };
            if (e.type === 'llm.end' && cur)
              return { streams: { ...s.streams, [id]: { ...cur, done: true } } };
            return {};
          });
        }
      },
      (connected) => set((s) => ({ connected, revision: connected ? s.revision + 1 : s.revision })),
    ),
}));

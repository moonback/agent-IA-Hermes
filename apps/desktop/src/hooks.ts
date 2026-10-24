import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, ApiError } from './api';
import { useApp } from './store';

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetches a JSON resource and refetches it when persisted events arrive (debounced),
 * so every screen reflects real server state instead of optimistic guesses.
 */
export function useResource<T>(
  path: string | null,
  opts: { live?: boolean; intervalMs?: number } = {},
): Resource<T> {
  // Data is tagged with the path it was fetched for, so switching resources never shows stale content.
  const [state, setState] = useState<{ path: string | null; data: T | null; error: ApiError | null }>({
    path: null,
    data: null,
    error: null,
  });
  const [tick, setTick] = useState(0);
  const revision = useApp((s) => s.revision);
  const live = opts.live ?? true;
  const debounced = useRef<number | null>(null);
  const [liveTick, setLiveTick] = useState(0);

  useEffect(() => {
    if (!live) return;
    if (debounced.current) window.clearTimeout(debounced.current);
    debounced.current = window.setTimeout(() => setLiveTick((n) => n + 1), 300);
    return () => {
      if (debounced.current) window.clearTimeout(debounced.current);
    };
  }, [revision, live]);

  useEffect(() => {
    if (!opts.intervalMs) return;
    const t = window.setInterval(() => setTick((n) => n + 1), opts.intervalMs);
    return () => window.clearInterval(t);
  }, [opts.intervalMs]);

  useEffect(() => {
    if (!path) return;
    const ctrl = new AbortController();
    api<T>(path, { signal: ctrl.signal })
      .then((data) => setState({ path, data, error: null }))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        const error = e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', String(e));
        setState((s) => ({ path, data: s.path === path ? s.data : null, error }));
      });
    return () => ctrl.abort();
  }, [path, tick, liveTick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const current = state.path === path;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: path !== null && !current,
    reload,
  };
}

/** Wraps a mutating API call with pending/error state. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>, onDone?: (r: R) => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setPending(true);
      setError(null);
      try {
        const r = await fn(...args);
        onDone?.(r);
        return r;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [fn, onDone],
  );
  return { run, pending, error, clearError: () => setError(null) };
}

/** Tracks a CSS media query (window size, OS preferences); the listener is removed on unmount. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

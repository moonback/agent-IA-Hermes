import { Check } from 'lucide-react';
import { APP_THEMES, THEME_INFO, type AppTheme } from '../../theme';
import { cx } from '../ui';

/** Decorative miniature drawn with the theme's own tokens (data-theme on the subtree). */
export function ThemePreview({ theme }: { theme: AppTheme }) {
  return (
    <span data-theme={theme} className="theme-preview flex h-28 gap-2 rounded-card p-2" aria-hidden>
      <span className="glass flex w-12 flex-col gap-1.5 rounded-control p-1.5">
        <span className="brand-mark mb-1 block h-2.5 w-4 rounded-sm" />
        <span className="nav-item block h-2 min-h-0 rounded-sm" aria-current="page" />
        <span className="block h-2 rounded-sm bg-neutral-soft" />
        <span className="block h-2 rounded-sm bg-neutral-soft" />
      </span>
      <span className="flex flex-1 flex-col gap-2">
        <span className="glass is-live flex items-center gap-1.5 rounded-control p-1.5">
          <span className="live-dot size-1.5 text-info-fg" />
          <span className="block h-1.5 flex-1 rounded-full bg-fg/70" />
          <span className="block h-3 w-8 rounded-sm bg-accent" />
        </span>
        <span className="grid flex-1 grid-cols-2 gap-2">
          <span className="glass flex flex-col justify-between rounded-control p-1.5">
            <span className="block h-1.5 w-3/4 rounded-full bg-muted/70" />
            <span className="block h-2 w-8 rounded-sm bg-success-soft ring-1 ring-success-fg/40" />
          </span>
          <span className="glass flex flex-col justify-between rounded-control p-1.5">
            <span className="block h-1.5 w-2/3 rounded-full bg-muted/70" />
            <span className="progress-track block">
              <span className="progress-bar block w-2/3" />
            </span>
          </span>
        </span>
      </span>
    </span>
  );
}

/** Native radio group: arrow keys, Tab and screen readers work out of the box. */
export function ThemeSelector({ value, onChange }: { value: AppTheme; onChange: (t: AppTheme) => void }) {
  return (
    <fieldset>
      <legend className="sr-only">Thème de l’interface</legend>
      <div className="grid gap-3 md:grid-cols-3">
        {APP_THEMES.map((t) => {
          const info = THEME_INFO[t];
          const selected = t === value;
          return (
            <label
              key={t}
              className={cx(
                'card-hover relative flex cursor-pointer flex-col gap-2.5 rounded-panel bg-raised p-2.5 ring-inset has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-(--hm-focus)',
                selected ? 'ring-2 ring-accent-fg' : 'ring-1 ring-line hover:ring-line-strong',
              )}
            >
              <input
                type="radio"
                name="app-theme"
                value={t}
                checked={selected}
                onChange={() => onChange(t)}
                aria-label={info.name}
                aria-describedby={`theme-desc-${t}`}
                className="sr-only"
              />
              <span className="relative block">
                <ThemePreview theme={t} />
                {selected && (
                  <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-on-accent shadow">
                    <Check className="size-3" aria-hidden /> Sélectionné
                  </span>
                )}
              </span>
              <span className="flex flex-wrap items-baseline justify-between gap-x-2 px-1">
                <span className="text-sm font-semibold">{info.name}</span>
                <span className="text-xs text-faint">{info.scheme === 'light' ? 'Clair' : 'Sombre'}</span>
              </span>
              <span id={`theme-desc-${t}`} className="px-1 pb-1 text-xs text-muted">
                {info.description}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

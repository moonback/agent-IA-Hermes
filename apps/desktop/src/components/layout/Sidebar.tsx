import type { KeyboardEvent } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useApp } from '../../store';
import { cx } from '../ui';
import { NAV_SECTIONS } from './nav';

/** Arrow keys move between navigation entries (Tab still works as usual). */
function onNavKeyDown(e: KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-nav]')];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  e.preventDefault();
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}

export function Sidebar({
  collapsed,
  canCollapse,
  onToggle,
  version,
}: {
  collapsed: boolean;
  /** False when the window is too narrow: the compact rail is then forced. */
  canCollapse: boolean;
  onToggle: () => void;
  version: string | undefined;
}) {
  const page = useApp((s) => s.page);
  const navigate = useApp((s) => s.navigate);

  return (
    <aside
      className={cx(
        'glass relative z-20 flex shrink-0 flex-col rounded-none border-y-0 border-l-0 transition-[width] duration-200',
        collapsed ? 'w-(--sidebar-collapsed)' : 'w-(--sidebar-width)',
      )}
    >
      <div
        className={cx('flex h-(--topbar-height) items-center gap-2.5', collapsed ? 'justify-center' : 'px-4')}
      >
        <span className="brand-mark grid size-8 shrink-0 place-items-center rounded-control text-sm font-bold">
          H
        </span>
        {!collapsed && (
          <>
            <span className="brand-text text-base font-bold tracking-[0.18em]">HERMES</span>
            <span className="ml-auto text-xs text-faint">{version ?? ''}</span>
          </>
        )}
      </div>
      <nav
        aria-label="Navigation principale"
        // The compact rail is short enough not to scroll, and must not clip its tooltips.
        className={cx(
          'flex-1 px-2 pb-2',
          collapsed ? 'overflow-visible' : 'overflow-x-hidden overflow-y-auto',
        )}
        onKeyDown={onNavKeyDown}
      >
        {NAV_SECTIONS.map((section) => (
          <div key={section.title} className="mt-3 first:mt-1">
            {collapsed ? (
              <div className="mx-3 mb-1.5 border-t border-line" aria-hidden />
            ) : (
              <p className="mb-1 px-3 text-[0.68rem] font-semibold tracking-wider text-faint uppercase">
                {section.title}
              </p>
            )}
            <ul className="space-y-0.5">
              {section.items.map(({ id, label, icon: Icon }) => (
                <li key={id} className="group relative">
                  <button
                    type="button"
                    data-nav
                    aria-current={page === id ? 'page' : undefined}
                    onClick={() => navigate(id)}
                    className={cx(
                      'nav-item flex w-full items-center gap-2.5 rounded-control text-left text-sm',
                      collapsed ? 'justify-center px-0' : 'px-3',
                      page === id ? 'font-medium' : 'text-muted hover:bg-neutral-soft hover:text-fg',
                    )}
                  >
                    <Icon
                      className={cx('size-[1.1rem] shrink-0', page === id && 'text-accent-fg')}
                      aria-hidden
                    />
                    <span className={collapsed ? 'sr-only' : 'truncate'}>{label}</span>
                  </button>
                  {collapsed && (
                    // Visual tooltip for the compact rail; the button keeps its accessible name.
                    <span
                      aria-hidden
                      className="glass pointer-events-none absolute top-1/2 left-full z-30 ml-2 -translate-y-1/2 rounded-control bg-solid px-2 py-1 text-xs whitespace-nowrap opacity-0 transition-opacity group-has-[:focus-visible]:opacity-100 group-hover:opacity-100"
                    >
                      {label}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      {canCollapse && (
        <div className="border-t border-line p-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            title={collapsed ? 'Déployer la barre latérale' : 'Réduire la barre latérale'}
            className={cx(
              'press flex w-full items-center gap-2.5 rounded-control py-2 text-sm text-muted hover:bg-neutral-soft hover:text-fg',
              collapsed ? 'justify-center' : 'px-3',
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" aria-hidden />
            ) : (
              <PanelLeftClose className="size-4" aria-hidden />
            )}
            <span className={collapsed ? 'sr-only' : ''}>
              {collapsed ? 'Déployer la barre latérale' : 'Réduire la barre latérale'}
            </span>
          </button>
        </div>
      )}
    </aside>
  );
}

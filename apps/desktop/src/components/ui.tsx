import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import {
  AlertTriangle,
  Ban,
  CircleCheck,
  CircleDot,
  CircleX,
  Clock,
  ListChecks,
  Loader2,
  Pause,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import { STATUS_LABEL, STATUS_TONE, type Tone } from '../labels';

export type { Tone } from '../labels';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANTS: Record<Variant, string> = {
  primary: 'btn-primary bg-accent text-on-accent hover:bg-accent-hover',
  secondary: 'bg-raised text-fg ring-1 ring-line ring-inset hover:bg-neutral-soft hover:ring-line-strong',
  danger: 'bg-danger-fill text-on-danger hover:brightness-110',
  ghost: 'text-muted hover:bg-neutral-soft hover:text-fg',
};

export function Button({
  variant = 'secondary',
  pending,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; pending?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={cx(
        'press inline-flex items-center justify-center gap-1.5 rounded-control px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-55',
        VARIANTS[variant],
        className,
      )}
    >
      {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

/** Glass panel. `live` highlights something that is really running right now. */
export function Card({
  title,
  icon,
  actions,
  children,
  className,
  live,
}: {
  title?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  live?: boolean;
}) {
  return (
    <section className={cx('glass appear min-w-0 rounded-panel p-4', live && 'is-live', className)}>
      {(title || actions) && (
        <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && (
            <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg">
              {icon && (
                <span className="text-accent-fg" aria-hidden>
                  {icon}
                </span>
              )}
              {title}
            </h2>
          )}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

const TONES: Record<Tone, string> = {
  neutral: 'bg-neutral-soft text-neutral-fg',
  info: 'bg-info-soft text-info-fg',
  success: 'bg-success-soft text-success-fg',
  warning: 'bg-warning-soft text-warning-fg',
  danger: 'bg-danger-soft text-danger-fg',
};

export function Badge({
  tone = 'neutral',
  children,
  title,
  icon,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  icon?: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-current/15 ring-inset',
        TONES[tone],
      )}
    >
      {icon}
      {children}
    </span>
  );
}

// Each status also carries a distinct icon, so it is never conveyed by colour alone.
const STATUS_ICON: Record<string, LucideIcon> = {
  pending: Clock,
  ready: CircleDot,
  planned: ListChecks,
  waiting_approval: ShieldAlert,
  paused: Pause,
  interrupted: AlertTriangle,
  blocked: AlertTriangle,
  started: AlertTriangle,
  completed: CircleCheck,
  succeeded: CircleCheck,
  approved: CircleCheck,
  consumed: CircleCheck,
  deduplicated: CircleCheck,
  failed: CircleX,
  denied: CircleX,
  cancelled: Ban,
  expired: Ban,
  abandoned: Ban,
  scheduled: Clock,
  awaiting_start: ShieldAlert,
  skipped: Ban,
  error: CircleX,
};

export function StatusBadge({ status }: { status: string }) {
  const Icon = STATUS_ICON[status];
  const icon =
    status === 'running' ? (
      <span className="live-dot size-1.5" aria-hidden />
    ) : status === 'planning' ? (
      <Loader2 className="size-3 animate-spin" aria-hidden />
    ) : Icon ? (
      <Icon className="size-3" aria-hidden />
    ) : null;
  return (
    <Badge tone={STATUS_TONE[status] ?? 'neutral'} icon={icon}>
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

export function ErrorBox({ error, title = 'Erreur' }: { error: string | null | undefined; title?: string }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="appear flex gap-2 rounded-card bg-danger-soft p-3 text-sm text-danger-fg ring-1 ring-current/25 ring-inset"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        <p className="break-words text-fg">{error}</p>
      </div>
    </div>
  );
}

export function Empty({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted">
      {icon && (
        <span
          className="grid size-10 place-items-center rounded-full bg-raised text-faint ring-1 ring-line"
          aria-hidden
        >
          {icon}
        </span>
      )}
      <p>{children}</p>
    </div>
  );
}

export function Loading({ label = 'Chargement…' }: { label?: string }) {
  return (
    <p className="flex items-center gap-2 py-4 text-sm text-muted" role="status">
      <Loader2 className="size-4 animate-spin text-accent-fg" aria-hidden /> {label}
    </p>
  );
}

/** Only rendered where progress is really computable from server data. */
export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  // Spans only, so the bar can sit inside a button (cards).
  return (
    <span className="block space-y-1">
      <span className="flex justify-between text-xs text-muted">
        <span>{label}</span>
        <span className="tabular-nums">
          {value}/{max}
        </span>
      </span>
      <span
        className="progress-track block"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
      >
        <span className="progress-bar block" style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="glass appear flex min-w-0 items-start gap-3 rounded-card p-3.5">
      {icon && (
        <span
          className={cx('grid size-9 shrink-0 place-items-center rounded-control', TONES[tone ?? 'info'])}
          aria-hidden
        >
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <p className="text-xs leading-snug text-muted">{label}</p>
        <p className="text-xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="line-clamp-2 text-xs text-faint">{hint}</p>}
      </div>
    </div>
  );
}

/** Label / value rows, used by the summary panels. */
export function DataList({ rows }: { rows: [ReactNode, ReactNode, string?][] }) {
  return (
    <dl className="divide-y divide-line text-sm">
      {rows.map(([k, v, title], i) => (
        <div key={i} className="flex items-center justify-between gap-3 py-1.5" title={title}>
          <dt className="shrink-0 text-muted">{k}</dt>
          <dd className="min-w-0 truncate text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  id,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
  description?: string;
  id: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {description && (
          <p id={`${id}-desc`} className="text-xs text-muted">
            {description}
          </p>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? `${id}-desc` : undefined}
        onClick={() => onChange(!checked)}
        className={cx(
          'press relative h-6 w-11 shrink-0 rounded-full ring-1 ring-inset',
          checked ? 'bg-accent ring-transparent' : 'bg-raised ring-line-strong',
        )}
      >
        <span
          aria-hidden
          className={cx(
            'absolute top-0.5 left-0.5 size-5 rounded-full shadow transition-transform duration-150',
            checked ? 'translate-x-5 bg-on-accent' : 'bg-muted',
          )}
        />
      </button>
    </div>
  );
}

const field =
  'rounded-control border border-line-strong bg-solid/70 px-2.5 py-1.5 text-sm text-fg placeholder:text-faint transition-colors focus:border-accent-fg disabled:opacity-60';
// Full width unless the caller sets a width (w-full would otherwise always win over w-48 in the CSS order).
const fieldClass = (className?: string) =>
  cx(field, !/(^|\s)w-/.test(className ?? '') && 'w-full', className);

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={fieldClass(props.className)} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={fieldClass(props.className)} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={fieldClass(props.className)} />;
}

export function Field({
  label,
  hint,
  children,
  id,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  id: string;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-muted">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-faint">{hint}</p>}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="appear mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Inline code chip (tool ids, model ids). */
export function Code({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code
      title={title}
      className="rounded-md bg-raised px-1 py-0.5 font-mono text-xs ring-1 ring-line ring-inset"
    >
      {children}
    </code>
  );
}

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('fr-FR') : '—';
export const fmtDuration = (a: string | null, b: string | null) => {
  if (!a) return '—';
  const ms = (b ? Date.parse(b) : Date.now()) - Date.parse(a);
  return ms < 1000
    ? `${ms} ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(1)} s`
      : `${Math.round(ms / 60_000)} min`;
};
export const fmtUsd = (n: number | null | undefined) =>
  n == null ? '—' : `${n.toFixed(n < 0.01 ? 5 : 3)} $`;
export const fmtRelative = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86_400) return `il y a ${Math.round(s / 3600)} h`;
  return new Date(iso).toLocaleDateString('fr-FR');
};

export function Json({ value, max = 4000 }: { value: unknown; max?: number }) {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  return (
    <pre className="max-h-72 overflow-auto rounded-control bg-raised p-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap ring-1 ring-line ring-inset">
      {text.length > max ? `${text.slice(0, max)}\n… (tronqué)` : text}
    </pre>
  );
}

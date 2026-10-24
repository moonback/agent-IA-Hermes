import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent-600 text-white hover:bg-accent-500 disabled:bg-accent-600/50',
  secondary:
    'bg-white text-slate-800 ring-1 ring-slate-300 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700 dark:hover:bg-slate-700',
  danger: 'bg-red-600 text-white hover:bg-red-500 disabled:bg-red-600/50',
  ghost: 'text-slate-600 hover:bg-slate-200/60 dark:text-slate-300 dark:hover:bg-slate-800',
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
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        VARIANTS[variant],
        className,
      )}
    >
      {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx(
        'rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900',
        className,
      )}
    >
      {(title || actions) && (
        <header className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h2>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

const TONES = {
  neutral: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  info: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  success: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  danger: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
} as const;
export type Tone = keyof typeof TONES;

export function Badge({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  pending: 'neutral',
  ready: 'info',
  running: 'info',
  planning: 'info',
  planned: 'neutral',
  waiting_approval: 'warning',
  paused: 'warning',
  interrupted: 'warning',
  blocked: 'warning',
  completed: 'success',
  succeeded: 'success',
  approved: 'success',
  consumed: 'success',
  failed: 'danger',
  denied: 'danger',
  cancelled: 'neutral',
  expired: 'neutral',
  deduplicated: 'info',
  abandoned: 'neutral',
  started: 'warning',
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'en attente',
  ready: 'prête',
  running: 'en cours',
  planning: 'planification',
  planned: 'planifiée',
  waiting_approval: 'approbation requise',
  paused: 'en pause',
  interrupted: 'interrompue',
  blocked: 'bloquée',
  completed: 'terminée',
  succeeded: 'réussi',
  failed: 'échec',
  cancelled: 'annulée',
  denied: 'refusé',
  approved: 'approuvé',
  consumed: 'utilisée',
  expired: 'expirée',
  deduplicated: 'dédoublonné',
  abandoned: 'abandonné',
  started: 'incertain',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_LABEL[status] ?? status}</Badge>;
}

export function ErrorBox({ error, title = 'Erreur' }: { error: string | null | undefined; title?: string }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <p className="break-words">{error}</p>
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">{children}</p>;
}

export function Loading({ label = 'Chargement…' }: { label?: string }) {
  return (
    <p className="flex items-center gap-2 py-4 text-sm text-slate-500" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {label}
    </p>
  );
}

const field =
  'w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(field, props.className)} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(field, props.className)} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(field, props.className)} />;
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
      <label htmlFor={id} className="block text-xs font-medium text-slate-600 dark:text-slate-300">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
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
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
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

export function Json({ value, max = 4000 }: { value: unknown; max?: number }) {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  return (
    <pre className="max-h-72 overflow-auto rounded bg-slate-100 p-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap dark:bg-slate-950">
      {text.length > max ? `${text.slice(0, max)}\n… (tronqué)` : text}
    </pre>
  );
}

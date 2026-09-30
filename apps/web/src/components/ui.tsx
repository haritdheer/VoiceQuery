import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useEffect, useRef } from 'react';

/** Small shared primitives, kept dependency-free and theme-token driven. */

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/* --------------------------------- Button --------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55';
  const sizes: Record<ButtonSize, string> = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-sm',
    lg: 'px-5 py-2.5 text-base',
  };
  const variants: Record<ButtonVariant, string> = {
    primary: 'text-[var(--on-accent)] bg-[var(--accent)] hover:bg-[var(--accent-hover)]',
    secondary:
      'border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text-primary)] hover:bg-[var(--surface-2)]',
    ghost: 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
    danger: 'border border-[var(--critical)] text-[var(--critical)] hover:bg-[var(--critical-soft)]',
  };

  return (
    <button
      className={cx(base, sizes[size], variants[variant], className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx('h-4 w-4 animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ---------------------------------- Card ---------------------------------- */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cx(
        'rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/* --------------------------------- Badge ---------------------------------- */

type BadgeTone = 'neutral' | 'accent' | 'good' | 'warning' | 'critical';

export function Badge({
  tone = 'neutral',
  children,
  className,
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const tones: Record<BadgeTone, string> = {
    neutral: 'bg-[var(--surface-2)] text-[var(--text-secondary)]',
    accent: 'bg-[var(--accent-soft)] text-[var(--accent)]',
    good: 'bg-[var(--good-soft)] text-[var(--good)]',
    warning: 'bg-[var(--warning-soft)] text-[var(--warning)]',
    critical: 'bg-[var(--critical-soft)] text-[var(--critical)]',
  };
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* --------------------------------- Modal ---------------------------------- */

/**
 * Accessible dialog: focus moves in on open, Escape closes, a focus trap keeps
 * Tab inside, and focus returns to the trigger on close.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  closeOnBackdrop = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  closeOnBackdrop?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Held in a ref so the effect below can depend on `open` alone. Depending on
  // `onClose` re-ran the effect on every render — which re-focused the first
  // focusable element on every keystroke, yanking the caret out of whatever
  // the user was typing into as soon as any control sat above it.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    const focusable = panel?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;

      const items = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled'));
      if (items.length === 0) return;

      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      previouslyFocused.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-4 sm:items-center"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vq-modal-title"
        aria-describedby={description ? 'vq-modal-desc' : undefined}
        className="vq-rise w-full max-w-lg rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-6 shadow-2xl"
      >
        <h2 id="vq-modal-title" className="text-lg font-semibold text-[var(--text-primary)]">
          {title}
        </h2>
        {description && (
          <p id="vq-modal-desc" className="mt-2 text-sm text-[var(--text-secondary)]">
            {description}
          </p>
        )}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

/* -------------------------------- Disclosure ------------------------------- */

export function Disclosure({
  label,
  children,
  defaultOpen = false,
  right,
}: {
  label: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  right?: ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)]"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        <span className="inline-flex items-center gap-2">
          <svg
            className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
          >
            <path d="M4 2.5 8 6l-4 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {label}
        </span>
        {right}
      </summary>
      <div className="border-t border-[var(--border-subtle)] p-3">{children}</div>
    </details>
  );
}

/* ---------------------------------- Field --------------------------------- */

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-[var(--text-primary)]">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-[var(--text-muted)]">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs text-[var(--critical)]">
          {error}
        </p>
      )}
    </div>
  );
}

export const inputClass =
  'w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none';

/* --------------------------------- Alert ---------------------------------- */

export function Alert({
  tone = 'critical',
  title,
  children,
}: {
  tone?: 'critical' | 'warning' | 'good' | 'accent';
  title?: string;
  children: ReactNode;
}) {
  const tones = {
    critical: 'border-[var(--critical)] bg-[var(--critical-soft)] text-[var(--critical)]',
    warning: 'border-[var(--warning)] bg-[var(--warning-soft)] text-[var(--warning)]',
    good: 'border-[var(--good)] bg-[var(--good-soft)] text-[var(--good)]',
    accent: 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]',
  };
  return (
    <div role="alert" className={cx('rounded-lg border px-3 py-2 text-sm', tones[tone])}>
      {title && <p className="font-semibold">{title}</p>}
      <div className={title ? 'mt-0.5' : undefined}>{children}</div>
    </div>
  );
}

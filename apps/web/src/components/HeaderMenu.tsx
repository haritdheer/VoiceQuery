import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from './ui.tsx';

/**
 * The header actions, collapsed behind one button on narrow screens.
 *
 * At phone width the inline buttons ran out of room and overlapped the
 * wordmark, which is worse than hiding them: controls were there but
 * unreadable and overlapping the thing they sat on top of.
 */

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Rendered as the filled, primary-looking row. */
  emphasis?: boolean;
}

export function HeaderMenu({
  items,
  /**
   * Draws a pulsing ring until the menu is first opened.
   *
   * Collapsing controls behind a hamburger makes them discoverable only to
   * someone who already knows to look, so the ring points at it once. It
   * stops for good after the first open — an attention cue that never ends
   * is just noise, and by then the user has found it.
   */
  attention = false,
  label = 'Menu',
  className,
  children,
}: {
  items: MenuItem[];
  attention?: boolean;
  label?: string;
  className?: string;
  /** Optional extra content rendered above the items. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(() => {
    // Per browser, so the ring does not reappear on every visit. Storage can
    // throw in a private window, where forgetting is the harmless outcome.
    try {
      return localStorage.getItem('vq-menu-used') === '1';
    } catch {
      return false;
    }
  });
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle() {
    setOpen((v) => !v);
    if (!used) {
      setUsed(true);
      try {
        localStorage.setItem('vq-menu-used', '1');
      } catch {
        /* nothing depends on this persisting */
      }
    }
  }

  return (
    <div ref={wrapRef} className={cx('relative', className)}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className={cx(
          'relative rounded-lg p-2 text-[var(--text-secondary)] transition-colors',
          'hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
          attention && !used && 'vq-attention',
        )}
      >
        <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d={open ? 'M5 5l10 10M15 5L5 15' : 'M3 5.5h14M3 10h14M3 14.5h14'}
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="vq-rise absolute right-0 z-40 mt-2 w-56 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-1.5 shadow-2xl"
        >
          {children && (
            <div className="border-b border-[var(--border-subtle)] px-2.5 pt-1.5 pb-2.5">
              {children}
            </div>
          )}
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cx(
                'block w-full rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                item.emphasis
                  ? 'font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

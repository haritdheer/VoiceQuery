import { useEffect, useRef, useState } from 'react';
import { Button } from './ui.tsx';

/**
 * The compact "Demo" marker for narrow screens, with the explanation behind
 * a tap rather than spelled out in the header.
 *
 * The full "Demo · not signed in" wrapped onto two lines on a phone and
 * pushed the header controls into the wordmark. Shortening the label alone
 * would have cost the meaning, so the meaning moves into a popover — more of
 * it than fitted before, in fact.
 *
 * Opens on click, not hover: a phone has no hover, and this exists for
 * phones. Pointer devices get it on hover as well, which costs nothing.
 */
export function DemoBadge({ onUploadData }: { onUploadData: () => void }) {
  const [open, setOpen] = useState(false);
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

  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        /*
         * Opens, never toggles. With hover also opening it, a toggle made
         * the desktop case absurd: move the mouse over it to read the
         * explanation, click it, and it closes. Dismissal is mouse-leave,
         * a click outside, or Escape — all of which reach it either way.
         */
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-label="What demo mode means"
        className="inline-flex items-center gap-1 rounded-full bg-[var(--warning-soft)] px-2.5 py-1 text-xs font-medium whitespace-nowrap text-[var(--warning)]"
      >
        Demo
        <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M6 5.2v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="6" cy="3.4" r="0.7" fill="currentColor" />
        </svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Demo mode"
          className="vq-rise absolute right-0 z-40 mt-2 w-[17rem] rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3.5 shadow-2xl"
        >
          <p className="text-sm font-semibold text-[var(--text-primary)]">
            This is demo data
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-secondary)]">
            You're exploring a sample retail dataset without an account. The answers are written
            by a built-in rule, not an AI model — they show how the app works, not real analysis.
          </p>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
            The SQL, the query engine and the numbers in the tables are all genuine.
          </p>

          <div className="mt-3">
            <Button
              size="sm"
              className="w-full"
              onClick={() => {
                setOpen(false);
                onUploadData();
              }}
            >
              Upload a dataset
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { ConversationSummary } from '@voicequery/shared';
import { Alert, Modal, Spinner } from './ui.tsx';
import { api } from '../lib/api.ts';
import { formatRelativeTime } from '../lib/format.ts';

/**
 * Past conversations.
 *
 * The server has stored every one of these since the first release and the
 * typed client has had both endpoints all along — nothing ever called them.
 * Signing back in dropped you on an empty dashboard with your history intact
 * and unreachable.
 *
 * Fetched on open rather than held in the dashboard, so the list is current
 * after a conversation has been added, and costs nothing until asked for.
 */
export function HistoryModal({
  open,
  onClose,
  onPick,
  currentId,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (id: string) => void;
  /** Marked in the list so "resume" and "you are here" are distinguishable. */
  currentId: string | null;
}) {
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setItems(null);
    setError(null);

    void api
      .conversations()
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch(() => {
        if (!cancelled) setError('Your conversations could not be loaded.');
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Your conversations"
      description="Pick one up where you left it. Each is tied to the dataset it started on."
    >
      {error && <Alert tone="critical">{error}</Alert>}

      {!error && items === null && (
        <div className="flex justify-center py-8 text-[var(--text-muted)]">
          <Spinner className="h-5 w-5" />
          <span className="sr-only">Loading conversations</span>
        </div>
      )}

      {items?.length === 0 && (
        <p className="py-6 text-center text-sm text-[var(--text-secondary)]">
          Nothing here yet. Ask a question and it will be saved automatically.
        </p>
      )}

      {items && items.length > 0 && (
        <ul className="max-h-[22rem] space-y-1.5 overflow-y-auto">
          {items.map((c) => {
            const current = c.id === currentId;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  disabled={current}
                  onClick={() => onPick(c.id)}
                  className={
                    current
                      ? 'w-full cursor-default rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] p-3 text-left'
                      : 'w-full rounded-lg border border-[var(--border-subtle)] p-3 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--surface-2)]'
                  }
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm font-medium text-[var(--text-primary)]">
                      {c.title}
                    </span>
                    <span className="shrink-0 text-xs text-[var(--text-muted)]">
                      {current ? 'Open now' : formatRelativeTime(c.updatedAt)}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">
                    {c.datasetName} · {c.messageCount} message
                    {c.messageCount === 1 ? '' : 's'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

import { Button, Modal } from './ui.tsx';

/**
 * Shown once, immediately after an account is created.
 *
 * A new account lands on a dashboard already holding a sample dataset, which
 * reads as "here is some data" rather than "here is where your data goes".
 * Asking at the one moment the question is live costs a click and saves
 * people hunting for the upload control in a sidebar they have not looked at
 * yet — on a phone it is behind a menu, so it is genuinely hidden.
 *
 * Both answers are real answers. The sample is not a consolation prize: it
 * is the fastest way to see what the app does, and the demo script leans on
 * it. So neither option is styled as the lesser one.
 */
export function DatasetChoiceModal({
  open,
  onClose,
  onUpload,
  sampleName,
  sampleRows,
  freeCredits,
  creditsEnabled,
}: {
  open: boolean;
  /** Dismiss and stay with the sample. */
  onClose: () => void;
  onUpload: () => void;
  sampleName: string | null;
  sampleRows: number | null;
  freeCredits: number;
  creditsEnabled: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Your account is ready"
      description={
        creditsEnabled
          ? `You have ${freeCredits} free question${freeCredits === 1 ? '' : 's'}. What would you like to ask them about?`
          : 'What would you like to start with?'
      }
    >
      <div className="space-y-2">
        <button
          type="button"
          onClick={onUpload}
          className="w-full rounded-lg border border-[var(--border-strong)] p-3 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
        >
          <span className="block text-sm font-semibold text-[var(--text-primary)]">
            Upload my own CSV
          </span>
          <span className="mt-0.5 block text-xs text-[var(--text-secondary)]">
            Your file is parsed into its own isolated query engine. Nothing but the column names
            and the rows a query returns is ever sent to the AI provider.
          </span>
        </button>

        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-lg border border-[var(--border-strong)] p-3 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
        >
          <span className="block text-sm font-semibold text-[var(--text-primary)]">
            Use the sample dataset
          </span>
          <span className="mt-0.5 block text-xs text-[var(--text-secondary)]">
            {sampleName && sampleRows
              ? `${sampleName} — ${sampleRows.toLocaleString()} rows, already loaded. Ask a question straight away.`
              : 'Already loaded. Ask a question straight away.'}
          </span>
        </button>

        <p className="pt-1 text-center text-xs text-[var(--text-muted)]">
          You can upload later from the Datasets panel.
        </p>
      </div>
    </Modal>
  );
}

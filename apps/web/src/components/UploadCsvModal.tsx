import { useRef, useState } from 'react';
import type { AppConfigResponse } from '@voicequery/shared';
import { Alert, Button, Modal, cx } from './ui.tsx';
import { formatBytes } from '../lib/format.ts';

/**
 * Shows the shape of a file that answers well, then opens the file picker.
 *
 * The guidance here mirrors what `apps/api/src/datasets/csv.ts` actually does
 * on ingest — the header handling, the decorated-number and date forms it
 * recognises, and the tokens it counts as missing. Keep the two in step: a
 * promise made here that the parser does not keep is worse than no guidance.
 */

/** One row of the worked example, kept as data so the table stays readable. */
const EXAMPLE_HEADER = ['order_date', 'region', 'units', 'revenue'] as const;
const EXAMPLE_ROWS = [
  ['2024-03-14', 'North', '12', '$1,240.50'],
  ['2024-03-15', 'South', '4', '$380.00'],
  ['2024-03-15', 'North', '9', '$915.25'],
] as const;

const RULES: { title: string; body: string }[] = [
  {
    title: 'One header row, then data',
    body: 'The first row must be the column names. Anything above it — a report title, a blank line, a logo row — becomes your header and the file reads as nonsense.',
  },
  {
    title: 'One row per record',
    body: 'No merged cells, no sub-headings between sections, and no totals row at the bottom. A totals row is counted as data, so every average and sum comes out wrong.',
  },
  {
    title: 'Dates as 2024-03-14',
    body: 'Or 14/03/2024. Other formats are kept as plain text, which means no trends over time and no date filtering.',
  },
  {
    title: 'Numbers can keep their decoration',
    body: '$1,234.50, 45% and (120) for negatives are all understood. Units inside the value are not — write 12, not 12 kg.',
  },
  {
    title: 'Leave missing values empty',
    body: 'Blank, NULL, NA and - are all read as missing. A placeholder like 0 or “unknown” is counted as a real value instead.',
  },
];

export function UploadCsvModal({
  open,
  onClose,
  limits,
  uploading,
  error,
  hint,
  onFile,
}: {
  open: boolean;
  onClose: () => void;
  limits: AppConfigResponse['limits'];
  uploading: boolean;
  error: string | null;
  hint: string | null;
  onFile: (file: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      // An accidental backdrop click mid-upload would hide the progress and
      // any error the request is about to return.
      closeOnBackdrop={!uploading}
      title="Upload a CSV"
      description="Any comma-separated file works. These few things are what separate a file that answers well from one that answers vaguely."
    >
      <div className="space-y-5">
        {/* ------------------------------ example ----------------------------- */}
        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">
            What a good file looks like
          </h3>
          <div className="overflow-x-auto rounded-lg border border-[var(--border-subtle)]">
            <table className="w-full border-collapse font-mono text-xs">
              <thead>
                <tr className="bg-[var(--surface-2)]">
                  {EXAMPLE_HEADER.map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="px-3 py-2 text-left font-semibold whitespace-nowrap text-[var(--text-secondary)]"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {EXAMPLE_ROWS.map((row, i) => (
                  <tr key={i} className="border-t border-[var(--border-subtle)]">
                    {row.map((cell, j) => (
                      <td
                        key={j}
                        className="px-3 py-1.5 whitespace-nowrap text-[var(--text-primary)]"
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            Column names are lower-cased and spaces become underscores, so “Order Date” arrives
            as <code className="font-mono">order_date</code>. Duplicate names are numbered rather
            than dropped.
          </p>
        </section>

        {/* ------------------------------- rules ------------------------------ */}
        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">
            Five things worth checking
          </h3>
          <ul className="space-y-2">
            {RULES.map((rule) => (
              <li key={rule.title} className="flex gap-2.5">
                <svg
                  className="mt-0.5 h-4 w-4 shrink-0 text-[var(--good)]"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M3.5 8.5l3 3 6-7"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
                  <strong className="font-medium text-[var(--text-primary)]">{rule.title}.</strong>{' '}
                  {rule.body}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* ------------------------------ dropzone ---------------------------- */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (uploading) return;
            const file = e.dataTransfer.files[0];
            if (file) onFile(file);
          }}
          className={cx(
            'rounded-xl border-2 border-dashed p-5 text-center transition-colors',
            dragging
              ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
              : 'border-[var(--border-strong)] bg-[var(--surface-1)]',
          )}
        >
          <Button
            size="md"
            loading={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? 'Reading your file' : 'Choose a CSV file'}
          </Button>
          <p className="mt-2.5 text-xs text-[var(--text-muted)]">or drag one onto this panel</p>
          <p className="mt-3 text-xs text-[var(--text-muted)]">
            Up to {formatBytes(limits.maxUploadBytes)} · {limits.maxRows.toLocaleString()} rows ·{' '}
            {limits.maxColumns} columns · deleted automatically after {limits.datasetTtlHours}{' '}
            hours
          </p>
        </div>

        {error && (
          <Alert tone="critical">
            {error}
            {hint && <p className="mt-1 opacity-90">{hint}</p>}
          </Alert>
        )}

        <p className="text-xs leading-relaxed text-[var(--text-muted)]">
          <strong className="text-[var(--text-secondary)]">What leaves your browser:</strong> the
          whole file is uploaded and queried on the server, but only your column names, types, a
          few example values per column and the rows a query returns are ever sent to an AI
          provider.
        </p>

        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={uploading}>
            Cancel
          </Button>
        </div>

        {/*
          Last in the DOM so the dialog's initial focus lands on the primary
          button, and tabindex={-1} keeps it out of the focus trap's cycle.
        */}
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          tabIndex={-1}
          className="sr-only"
          id="vq-csv-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset immediately: picking the same file twice after a failed
            // first attempt fires no change event otherwise.
            e.target.value = '';
            if (file) onFile(file);
          }}
        />
      </div>
    </Modal>
  );
}

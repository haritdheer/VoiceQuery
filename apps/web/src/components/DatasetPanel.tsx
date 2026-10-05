import { useEffect, useState } from 'react';
import type { AppConfigResponse, DatasetDetail, DatasetSummary } from '@voicequery/shared';
import { Alert, Badge, Button, Card, Disclosure, cx } from './ui.tsx';
import { UploadCsvModal } from './UploadCsvModal.tsx';
import { formatBytes, formatCell, hoursUntil } from '../lib/format.ts';
import { api, ApiRequestError } from '../lib/api.ts';

export function DatasetPanel({
  datasets,
  selectedId,
  detail,
  limits,
  isGuest = false,
  onRequestAccount,
  onSelect,
  onUploaded,
  onDeleted,
  openUploadToken,
}: {
  datasets: DatasetSummary[];
  selectedId: string | null;
  detail: DatasetDetail | null;
  limits: AppConfigResponse['limits'];
  /** Guests cannot upload; the control explains why instead of failing. */
  isGuest?: boolean;
  onRequestAccount?: () => void;
  onSelect: (id: string) => void;
  onUploaded: (dataset: DatasetDetail) => void;
  onDeleted: (id: string) => void;
  /**
   * Changing this opens the upload dialog. A token rather than a boolean so
   * the parent can ask twice without having to reset anything in between.
   */
  openUploadToken?: number;
}) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Resolves to whether the dataset landed, so the dialog knows to close. */
  async function upload(file: File): Promise<boolean> {
    setError(null);
    setHint(null);

    // Fail fast on obvious problems so the user is not left waiting.
    if (!/\.csv$/i.test(file.name)) {
      setError('Only .csv files are supported.');
      return false;
    }
    if (file.size > limits.maxUploadBytes) {
      setError(
        `That file is ${formatBytes(file.size)}, above the ${formatBytes(limits.maxUploadBytes)} limit.`,
      );
      return false;
    }

    setUploading(true);
    try {
      const dataset = await api.uploadCsv(file);
      onUploaded(dataset);
      return true;
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.message);
        const details = err.details as { hint?: string } | undefined;
        if (details?.hint) setHint(details.hint);
      } else {
        setError('The upload failed. Please try again.');
      }
      return false;
    } finally {
      setUploading(false);
    }
  }

  // The sample doubles as the worked example in the upload dialog: it is the
  // one file guaranteed to be present and guaranteed to parse cleanly.
  const sampleDatasetId = datasets.find((d) => d.kind === 'sample')?.id ?? null;

  function openUploadDialog() {
    // A message left over from a previous attempt would read as a failure of
    // the upload the user is only just starting.
    setError(null);
    setHint(null);
    setUploadOpen(true);
  }

  // Opened from outside — the post-sign-up prompt asking what to analyse.
  // Guests have no upload route at all, so their token is ignored.
  useEffect(() => {
    if (openUploadToken && !isGuest) openUploadDialog();
    // openUploadDialog only ever resets local state, so it is safe to leave
    // out; re-running on its identity would reopen the dialog on any render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openUploadToken, isGuest]);

  async function remove(id: string, name: string) {
    if (!window.confirm(`Delete "${name}"? This removes the uploaded data permanently.`)) return;
    try {
      await api.deleteDataset(id);
      onDeleted(id);
    } catch {
      setError('That dataset could not be deleted.');
    }
  }

  return (
    <div className="space-y-4">
      <section aria-labelledby="vq-datasets-heading">
        <h2
          id="vq-datasets-heading"
          className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase"
        >
          Datasets
        </h2>

        <ul className="space-y-1.5">
          {datasets.map((dataset) => {
            const active = dataset.id === selectedId;
            const ttl = hoursUntil(dataset.expiresAt);
            return (
              <li key={dataset.id}>
                <div
                  className={cx(
                    'group flex items-start gap-2 rounded-lg border p-2.5 transition-colors',
                    active
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border-subtle)] bg-[var(--surface-raised)] hover:border-[var(--border-strong)]',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(dataset.id)}
                    aria-current={active ? 'true' : undefined}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-[var(--text-primary)]">
                        {dataset.name}
                      </span>
                      {dataset.kind === 'sample' && <Badge tone="accent">Sample</Badge>}
                    </span>
                    <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
                      {dataset.rowCount.toLocaleString()} rows · {dataset.columnCount} columns
                      {ttl !== null && ` · expires in ${ttl}h`}
                    </span>
                  </button>

                  <span className="flex shrink-0 items-center">
                    {/*
                      An anchor, not a button with JS: the browser downloads it
                      natively straight to disk instead of the page buffering
                      a whole dataset in memory to hand back.
                    */}
                    <a
                      href={api.datasetDownloadUrl(dataset.id)}
                      download={`${dataset.name}.csv`}
                      onClick={(e) => e.stopPropagation()}
                      title="Download as CSV"
                      aria-label={`Download ${dataset.name} as CSV`}
                      className="rounded p-1 text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-[var(--accent)]"
                    >
                      <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path
                          d="M8 2.5v7.5m0 0L5.25 7.25M8 10l2.75-2.75M3 11.5v1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1"
                          stroke="currentColor"
                          strokeWidth="1.3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </a>

                    {dataset.kind === 'upload' && (
                      <button
                        type="button"
                        onClick={() => void remove(dataset.id, dataset.name)}
                        aria-label={`Delete dataset ${dataset.name}`}
                        className="rounded p-1 text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-[var(--critical)]"
                      >
                        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path
                            d="M3 4.5h10M6.5 4.5V3.5a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4.5 4.5l.5 8a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8"
                            stroke="currentColor"
                            strokeWidth="1.3"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ------------------------------- upload ------------------------------ */}
      <section aria-labelledby="vq-upload-heading">
        <h2 id="vq-upload-heading" className="sr-only">
          Upload a CSV
        </h2>
        {isGuest ? (
          <div className="rounded-lg border border-dashed border-[var(--border-strong)] p-3 text-center">
            <p className="text-sm font-medium text-[var(--text-primary)]">
              Want to analyse your own data?
            </p>
            <p className="mt-1 mb-2.5 text-xs text-[var(--text-muted)]">
              Uploading a CSV needs a free account.
            </p>
            <Button variant="secondary" size="sm" onClick={() => onRequestAccount?.()}>
              Create a free account
            </Button>
          </div>
        ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files[0];
            if (file) void upload(file);
          }}
          className={cx(
            'rounded-lg border border-dashed p-3 text-center transition-colors',
            dragging
              ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
              : 'border-[var(--border-strong)]',
          )}
        >
          <Button
            variant="secondary"
            size="sm"
            loading={uploading}
            onClick={openUploadDialog}
          >
            {uploading ? 'Processing' : 'Upload CSV'}
          </Button>
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            or drop a file here · max {formatBytes(limits.maxUploadBytes)},{' '}
            {limits.maxRows.toLocaleString()} rows, {limits.maxColumns} columns
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Uploads are deleted automatically after {limits.datasetTtlHours} hours.
          </p>
        </div>

        )}

        {/* The dialog shows the same message; only one of the two is visible. */}
        {error && !uploadOpen && (
          <div className="mt-2">
            <Alert tone="critical">
              {error}
              {hint && <p className="mt-1 opacity-90">{hint}</p>}
            </Alert>
          </div>
        )}
      </section>

      <UploadCsvModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        limits={limits}
        uploading={uploading}
        error={error}
        hint={hint}
        onFile={(file) => {
          void upload(file).then((ok) => {
            if (ok) setUploadOpen(false);
          });
        }}
        sampleDownloadUrl={sampleDatasetId ? api.datasetDownloadUrl(sampleDatasetId) : null}
      />

      {/* ------------------------------- schema ------------------------------ */}
      {detail && (
        <section aria-labelledby="vq-schema-heading" className="space-y-2">
          <h2 id="vq-schema-heading" className="sr-only">
            Dataset schema
          </h2>

          {detail.warnings.length > 0 && (
            <Alert tone="warning" title="Notes on this file">
              <ul className="list-inside list-disc space-y-0.5">
                {detail.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </Alert>
          )}

          <Disclosure label={`Schema (${detail.columns.length} columns)`}>
            <ul className="space-y-1.5">
              {detail.columns.map((col) => (
                <li key={col.name} className="text-xs">
                  <div className="flex items-baseline justify-between gap-2">
                    <code className="font-mono text-[var(--text-primary)]">{col.name}</code>
                    <span className="shrink-0 text-[var(--text-muted)]">{col.type}</span>
                  </div>
                  {col.originalName !== col.name && (
                    <p className="text-[var(--text-muted)]">from “{col.originalName}”</p>
                  )}
                  {col.nullCount > 0 && (
                    <p className="text-[var(--text-muted)]">
                      {col.nullCount.toLocaleString()} missing
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </Disclosure>

          <Disclosure label="Data preview">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)]">
                    {detail.columns.map((c) => (
                      <th
                        key={c.name}
                        scope="col"
                        className="px-2 py-1 text-left font-semibold whitespace-nowrap text-[var(--text-secondary)]"
                      >
                        {c.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detail.preview.map((row, i) => (
                    <tr key={i} className="border-b border-[var(--border-subtle)] last:border-0">
                      {detail.columns.map((c) => (
                        <td
                          key={c.name}
                          className="px-2 py-1 whitespace-nowrap text-[var(--text-primary)]"
                        >
                          {formatCell(row[c.name])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Disclosure>

          <Card className="p-3">
            <p className="text-xs leading-relaxed text-[var(--text-muted)]">
              <strong className="text-[var(--text-secondary)]">What is sent to the AI provider:</strong>{' '}
              your column names and types, a few example values per column, and the rows your
              query returns. The full dataset is never uploaded to the model.
            </p>
          </Card>
        </section>
      )}
    </div>
  );
}

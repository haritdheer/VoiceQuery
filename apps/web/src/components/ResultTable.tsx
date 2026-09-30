import { useState } from 'react';
import type { QueryResult } from '@voicequery/shared';
import { formatCell } from '../lib/format.ts';
import { Button } from './ui.tsx';

const INITIAL_ROWS = 8;

export function ResultTable({ result }: { result: QueryResult }) {
  const [expanded, setExpanded] = useState(false);

  if (result.rows.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-sm text-[var(--text-secondary)]">
        The query ran successfully but matched no rows.
      </p>
    );
  }

  const visible = expanded ? result.rows : result.rows.slice(0, INITIAL_ROWS);
  const hidden = result.rows.length - visible.length;

  return (
    <div>
      {/* Only the table scrolls sideways; the page itself never does. */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Query results: {result.rows.length} of {result.totalRows} rows
          </caption>
          <thead>
            <tr className="border-b border-[var(--border-subtle)]">
              {result.columns.map((col) => (
                <th
                  key={col}
                  scope="col"
                  className="whitespace-nowrap px-3 py-2 text-left text-xs font-semibold tracking-wide text-[var(--text-secondary)] uppercase"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, i) => (
              <tr
                key={i}
                className="border-b border-[var(--border-subtle)] last:border-0 hover:bg-[var(--surface-2)]"
              >
                {result.columns.map((col) => {
                  const value = row[col];
                  return (
                    <td
                      key={col}
                      className={`px-3 py-2 whitespace-nowrap text-[var(--text-primary)] ${
                        typeof value === 'number' ? 'text-right tabular-nums' : ''
                      }`}
                    >
                      {formatCell(value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-3 py-2">
        <p className="text-xs text-[var(--text-muted)]">
          {result.truncated ? (
            <>
              Showing {result.rows.length.toLocaleString()} of{' '}
              {result.totalRows.toLocaleString()} rows. Totals and averages above were
              calculated across the full result.
            </>
          ) : (
            <>
              {result.rows.length.toLocaleString()} row{result.rows.length === 1 ? '' : 's'}
            </>
          )}
        </p>
        {hidden > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
            Show {hidden.toLocaleString()} more
          </Button>
        )}
        {expanded && result.rows.length > INITIAL_ROWS && (
          <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>
            Collapse
          </Button>
        )}
      </div>
    </div>
  );
}

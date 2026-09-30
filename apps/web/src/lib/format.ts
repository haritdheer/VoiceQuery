/** Display formatting. Kept in one place so charts and tables always agree. */

export function formatNumber(value: unknown, format: 'number' | 'currency' | 'percent' = 'number'): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);

  if (format === 'percent') {
    return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  }
  if (format === 'currency') {
    return n.toLocaleString(undefined, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2,
    });
  }
  // Floating-point sums produce values like 166202.54000000004; two decimals
  // is the honest precision for a money-like aggregate.
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Compact axis labels: 1.2M rather than 1,200,000. */
export function formatCompact(value: unknown, format: 'number' | 'currency' | 'percent' = 'number'): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  if (format === 'percent') return `${Math.round(n)}%`;

  const compact = new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);
  return format === 'currency' ? `$${compact}` : compact;
}

/** Cell rendering for the result table. */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  const s = String(value);
  // DuckDB returns DATE as an ISO string; trim the time part when it is midnight.
  const isoMidnight = /^(\d{4}-\d{2}-\d{2})T00:00:00(\.000)?Z?$/.exec(s);
  if (isoMidnight) return isoMidnight[1]!;
  return s;
}

/** Axis tick for a possibly-date category. */
export function formatCategory(value: unknown): string {
  const s = formatCell(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
    }
  }
  return s.length > 18 ? `${s.slice(0, 17)}…` : s;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Hours until a dataset expires, for the TTL badge. */
export function hoursUntil(iso: string | null): number | null {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(diff)) return null;
  return Math.max(0, Math.round(diff / 3_600_000));
}

export function formatMoney(amountMinor: number, currency: string): string {
  return (amountMinor / 100).toLocaleString(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
  });
}

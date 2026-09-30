import Papa from 'papaparse';
import type { ColumnSchema, ColumnType } from '@voicequery/shared';

/**
 * Server-side CSV validation and type inference.
 *
 * Nothing here trusts the client: the browser's preview is cosmetic, and this
 * module re-derives everything from the uploaded bytes. Cell values are never
 * logged — only counts, names and types leave this file.
 */

export class CsvValidationError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'CsvValidationError';
  }
}

export interface ParsedCsv {
  columns: ColumnSchema[];
  /** Cell values as raw strings; typed conversion happens in DuckDB. */
  rows: (string | null)[][];
  rowCount: number;
  warnings: string[];
  /** DuckDB column types, index-aligned with `columns`. */
  sqlTypes: string[];
}

export interface ParseOptions {
  maxRows: number;
  maxColumns: number;
  /** Rows scanned to infer a column's type. */
  sampleSize?: number;
}

/** Column names are rewritten to a safe identifier form for the SQL layer. */
function sanitiseName(raw: string, index: number): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, '_$1');
  return cleaned.length > 0 ? cleaned.slice(0, 60) : `column_${index + 1}`;
}

const TRUE_VALUES = new Set(['true', 'yes', 'y', 't', '1']);
const FALSE_VALUES = new Set(['false', 'no', 'n', 'f', '0']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_SLASH_RE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?/;
// Accepts 1234, 1,234.56, -12.5, $99, 45%, (123) for negatives.
const NUMERIC_RE = /^-?\$?\(?-?[\d,]*\.?\d+\)?%?$/;

function isBlank(v: string | null | undefined): boolean {
  if (v === null || v === undefined) return true;
  const t = v.trim();
  return t === '' || t.toLowerCase() === 'null' || t.toLowerCase() === 'na' || t === '-';
}

/** Strips currency/grouping decoration so "$1,234.50" reads as a number. */
export function normaliseNumeric(value: string): string | null {
  let v = value.trim();
  const negativeParens = v.startsWith('(') && v.endsWith(')');
  if (negativeParens) v = v.slice(1, -1);
  const isPercent = v.endsWith('%');
  if (isPercent) v = v.slice(0, -1);
  v = v.replace(/[$£€,\s]/g, '');
  if (v === '' || v === '-') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return String(negativeParens ? -n : n);
}

function inferType(samples: string[]): ColumnType {
  if (samples.length === 0) return 'string';

  let numeric = 0;
  let integer = 0;
  let date = 0;
  let timestamp = 0;
  let boolean = 0;

  for (const s of samples) {
    const t = s.trim();
    const lower = t.toLowerCase();
    if (TRUE_VALUES.has(lower) || FALSE_VALUES.has(lower)) boolean++;
    if (TIMESTAMP_RE.test(t)) timestamp++;
    else if (DATE_RE.test(t) || DATE_SLASH_RE.test(t)) date++;
    if (NUMERIC_RE.test(t)) {
      const n = normaliseNumeric(t);
      if (n !== null) {
        numeric++;
        if (Number.isInteger(Number(n))) integer++;
      }
    }
  }

  const n = samples.length;
  const threshold = 0.9;

  // Dates first: "2024" style years would otherwise read as integers, but a
  // full ISO date never parses as numeric, so ordering only matters here.
  if (timestamp / n >= threshold) return 'timestamp';
  if (date / n >= threshold) return 'date';
  // A 0/1 column is more useful as a number than as a boolean, so booleans
  // only win when the values are genuinely non-numeric words.
  if (boolean / n >= threshold && numeric / n < threshold) return 'boolean';
  if (numeric / n >= threshold) return integer === numeric ? 'integer' : 'number';
  return 'string';
}

const SQL_TYPE: Record<ColumnType, string> = {
  string: 'VARCHAR',
  number: 'DOUBLE',
  integer: 'BIGINT',
  date: 'DATE',
  timestamp: 'TIMESTAMP',
  boolean: 'BOOLEAN',
};

export function parseCsv(content: string, options: ParseOptions): ParsedCsv {
  const sampleSize = options.sampleSize ?? 500;
  const warnings: string[] = [];

  if (content.trim().length === 0) {
    throw new CsvValidationError('The file is empty.', 'Upload a CSV with a header row and at least one data row.');
  }

  // Strip a UTF-8 BOM, which otherwise becomes part of the first header name.
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
  });

  if (parsed.errors.length > 0) {
    // Papa reports recoverable issues per row; only a failure on the header
    // row is fatal, the rest become warnings.
    const fatal = parsed.errors.find((e) => e.row === 0 || e.type === 'Delimiter');
    if (fatal) {
      throw new CsvValidationError(
        `Could not read the CSV: ${fatal.message}`,
        'Check that the file is comma-separated and has a single header row.',
      );
    }
    const shown = parsed.errors.slice(0, 3).map((e) => `row ${(e.row ?? 0) + 1}: ${e.message}`);
    warnings.push(
      `${parsed.errors.length} row(s) had formatting problems and were read leniently (${shown.join('; ')}).`,
    );
  }

  const table = parsed.data.filter((r) => Array.isArray(r) && r.some((c) => !isBlank(c)));
  const headerRow = table[0];
  if (!headerRow || headerRow.length === 0) {
    throw new CsvValidationError('No header row was found.', 'The first row must contain column names.');
  }

  if (headerRow.length > options.maxColumns) {
    throw new CsvValidationError(
      `The file has ${headerRow.length} columns, above the limit of ${options.maxColumns}.`,
      'Remove columns you do not need and upload again.',
    );
  }

  const dataRows = table.slice(1);
  if (dataRows.length === 0) {
    throw new CsvValidationError('The file has a header but no data rows.');
  }
  if (dataRows.length > options.maxRows) {
    throw new CsvValidationError(
      `The file has ${dataRows.length.toLocaleString()} rows, above the limit of ${options.maxRows.toLocaleString()}.`,
      'Aggregate or sample the data before uploading.',
    );
  }

  /* ----------------------------- header names ---------------------------- */

  const seen = new Map<string, number>();
  const names: string[] = [];
  const originalNames: string[] = [];

  headerRow.forEach((rawHeader, i) => {
    const original = (rawHeader ?? '').trim() || `Column ${i + 1}`;
    originalNames.push(original);

    const base = sanitiseName(original, i);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);

    let name = occurrence === 1 ? base : `${base}_${occurrence}`;
    // A suffixed name could itself collide with a real column further along,
    // so keep incrementing until the name is genuinely free.
    let suffix = occurrence;
    while (names.includes(name)) {
      suffix++;
      name = `${base}_${suffix}`;
    }
    if (name !== base) {
      warnings.push(`Duplicate column "${original}" was renamed to "${name}".`);
    }
    names.push(name);
  });

  const width = names.length;

  /* --------------------------- normalise the grid ------------------------- */

  let raggedRows = 0;
  const rows: (string | null)[][] = dataRows.map((row) => {
    if (row.length !== width) raggedRows++;
    const out: (string | null)[] = new Array(width);
    for (let i = 0; i < width; i++) {
      const cell = row[i];
      out[i] = isBlank(cell) ? null : String(cell).trim();
    }
    return out;
  });

  if (raggedRows > 0) {
    warnings.push(
      `${raggedRows} row(s) did not have ${width} values; missing cells were treated as empty and extra cells ignored.`,
    );
  }

  /* ------------------------------ inference ------------------------------ */

  const columns: ColumnSchema[] = [];
  const sqlTypes: string[] = [];

  for (let i = 0; i < width; i++) {
    const colValues: string[] = [];
    let nullCount = 0;
    for (const row of rows) {
      const v = row[i];
      if (v === null || v === undefined) nullCount++;
      else if (colValues.length < sampleSize) colValues.push(v);
    }

    const type = inferType(colValues);
    sqlTypes.push(SQL_TYPE[type]);

    // Numeric columns get decoration stripped now so TRY_CAST succeeds later.
    if (type === 'number' || type === 'integer') {
      for (const row of rows) {
        const v = row[i];
        if (v != null) row[i] = normaliseNumeric(v);
      }
    }
    // US-style dates are rewritten to ISO so DATE casting is unambiguous.
    if (type === 'date') {
      for (const row of rows) {
        const v = row[i];
        if (v != null && DATE_SLASH_RE.test(v)) {
          const [m = '1', d = '1', y = '1970'] = v.split('/');
          row[i] = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        }
      }
    }

    const distinct = [...new Set(colValues)].slice(0, 12);

    columns.push({
      name: names[i]!,
      originalName: originalNames[i]!,
      type,
      nullable: nullCount > 0,
      // Bounded on purpose: these few values are the only cell contents that
      // are ever sent to the AI provider.
      sampleValues: distinct,
      nullCount,
    });
  }

  const allString = columns.every((c) => c.type === 'string');
  if (allString && columns.length > 1) {
    warnings.push(
      'No numeric or date columns were detected, so charts and aggregations will be limited.',
    );
  }

  return { columns, rows, rowCount: rows.length, warnings, sqlTypes };
}

import { describe, expect, it } from 'vitest';
import { parseCsv, CsvValidationError, normaliseNumeric } from '../src/datasets/csv.ts';

const OPTS = { maxRows: 1000, maxColumns: 20 };

describe('CSV type inference', () => {
  it('infers dates, integers, decimals and strings', () => {
    const csv = [
      'order_date,product,quantity,unit_price',
      '2024-01-05,Widget,3,12.50',
      '2024-02-06,Gadget,7,8.25',
      '2024-03-07,Doohickey,2,99.00',
    ].join('\n');

    const parsed = parseCsv(csv, OPTS);
    const types = Object.fromEntries(parsed.columns.map((c) => [c.name, c.type]));
    expect(types).toEqual({
      order_date: 'date',
      product: 'string',
      quantity: 'integer',
      unit_price: 'number',
    });
  });

  it('strips currency and thousands separators from numbers', () => {
    expect(normaliseNumeric('$1,234.50')).toBe('1234.5');
    expect(normaliseNumeric('(250)')).toBe('-250');
    expect(normaliseNumeric('45%')).toBe('45');
    expect(normaliseNumeric('not a number')).toBeNull();
  });

  it('converts US-style dates to ISO so casting is unambiguous', () => {
    const csv = 'when,value\n03/07/2024,1\n12/25/2024,2\n01/01/2024,3';
    const parsed = parseCsv(csv, OPTS);
    expect(parsed.columns[0]?.type).toBe('date');
    expect(parsed.rows[0]?.[0]).toBe('2024-03-07');
    expect(parsed.rows[1]?.[0]).toBe('2024-12-25');
  });
});

describe('CSV validation', () => {
  it('rejects an empty file', () => {
    expect(() => parseCsv('', OPTS)).toThrow(CsvValidationError);
  });

  it('rejects a header with no data rows', () => {
    expect(() => parseCsv('a,b,c', OPTS)).toThrow(CsvValidationError);
  });

  it('rejects a file with too many rows', () => {
    const csv = ['a,b', ...Array.from({ length: 12 }, (_, i) => `${i},${i}`)].join('\n');
    expect(() => parseCsv(csv, { maxRows: 5, maxColumns: 10 })).toThrow(/rows, above the limit/);
  });

  it('rejects a file with too many columns', () => {
    const header = Array.from({ length: 30 }, (_, i) => `c${i}`).join(',');
    const row = Array.from({ length: 30 }, () => '1').join(',');
    expect(() => parseCsv(`${header}\n${row}`, { maxRows: 100, maxColumns: 10 })).toThrow(
      /columns, above the limit/,
    );
  });
});

describe('CSV messy-input handling', () => {
  it('renames duplicate columns and warns', () => {
    const parsed = parseCsv('amount,amount,Amount\n1,2,3\n4,5,6', OPTS);
    const names = parsed.columns.map((c) => c.name);
    expect(new Set(names).size).toBe(3);
    expect(names[0]).toBe('amount');
    expect(parsed.warnings.join(' ')).toMatch(/Duplicate column/);
  });

  it('treats blanks, NULL and NA as missing and counts them', () => {
    const csv = 'label,value\na,1\nb,\nc,NULL\nd,NA\ne,5';
    const parsed = parseCsv(csv, OPTS);
    const value = parsed.columns.find((c) => c.name === 'value');
    expect(value?.nullable).toBe(true);
    expect(value?.nullCount).toBe(3);
    // The remaining values are still numeric, so the column stays numeric.
    expect(value?.type).toBe('integer');
  });

  it('pads ragged rows and warns instead of failing', () => {
    const csv = 'a,b,c\n1,2,3\n4,5\n6,7,8,9';
    const parsed = parseCsv(csv, OPTS);
    expect(parsed.rowCount).toBe(3);
    expect(parsed.rows[1]).toHaveLength(3);
    expect(parsed.rows[1]?.[2]).toBeNull();
    expect(parsed.warnings.join(' ')).toMatch(/did not have 3 values/);
  });

  it('sanitises header names into safe identifiers', () => {
    const parsed = parseCsv('Order Date,Total ($),2024 Count\n2024-01-01,5,3', OPTS);
    const names = parsed.columns.map((c) => c.name);
    expect(names[0]).toBe('order_date');
    expect(names[1]).toBe('total');
    // A name starting with a digit is prefixed so it is a valid identifier.
    expect(names[2]).toMatch(/^_?2024_count$/);
    // The original header is preserved for display.
    expect(parsed.columns[0]?.originalName).toBe('Order Date');
  });

  it('strips a UTF-8 BOM from the first header', () => {
    const parsed = parseCsv('﻿name,value\na,1', OPTS);
    expect(parsed.columns[0]?.name).toBe('name');
  });

  it('handles quoted fields containing commas', () => {
    const parsed = parseCsv('name,note\n"Smith, John",hello\n"Doe, Jane",world', OPTS);
    expect(parsed.rowCount).toBe(2);
    expect(parsed.rows[0]?.[0]).toBe('Smith, John');
  });

  it('bounds the sample values used for grounding the model', () => {
    const rows = Array.from({ length: 200 }, (_, i) => `item${i},1`).join('\n');
    const parsed = parseCsv(`label,value\n${rows}`, { maxRows: 1000, maxColumns: 10 });
    // Only a small, capped set of distinct values ever reaches the provider.
    expect(parsed.columns[0]!.sampleValues.length).toBeLessThanOrEqual(12);
  });

  it('warns when nothing is chartable', () => {
    const parsed = parseCsv('a,b\nfoo,bar\nbaz,qux', OPTS);
    expect(parsed.warnings.join(' ')).toMatch(/No numeric or date columns/);
  });
});

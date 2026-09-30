import { z } from 'zod';
import type { ChartKind, TokenUsage } from '@voicequery/shared';

/**
 * Provider-agnostic surface for the two model calls the pipeline makes.
 *
 * One provider is supported properly (Anthropic) rather than several
 * half-way. Adding another means implementing this interface and registering
 * it in registry.ts — nothing in the pipeline changes.
 */

export const ChartKinds = [
  'bar',
  'horizontalBar',
  'line',
  'area',
  'pie',
  'scatter',
  'none',
] as const satisfies readonly ChartKind[];

/**
 * What the model must return for step 5 of the pipeline. Enforced as a schema
 * rather than parsed out of prose, so a malformed generation is a hard error
 * instead of a silently wrong query.
 */
export const SqlPlanSchema = z.object({
  /**
   * Set when the question cannot be answered from the schema as written.
   * Producing a clarification instead of a guess is always preferred to
   * inventing a column.
   */
  needsClarification: z.boolean(),
  clarificationQuestion: z
    .string()
    .describe('A single specific question to ask the user. Empty when needsClarification is false.'),
  sql: z
    .string()
    .describe('A single read-only DuckDB SELECT statement. Empty when needsClarification is true.'),
  chartKind: z.enum(ChartKinds),
  chartTitle: z.string(),
  chartXKey: z.string().describe('Result column for the category/x axis. Empty if chartKind is none.'),
  chartYKeys: z.array(z.string()).describe('Numeric result columns to plot.'),
  valueFormat: z.enum(['number', 'currency', 'percent']),
});

export type SqlPlan = z.infer<typeof SqlPlanSchema>;

export interface SqlPlanRequest {
  question: string;
  /** Rendered schema description — column names, types, bounded sample values. */
  schemaText: string;
  /** Prior turns, already bounded by the caller. */
  history: { question: string; sql: string | null; answer: string }[];
  signal?: AbortSignal;
}

export interface ExplanationRequest {
  question: string;
  sql: string;
  /** A bounded slice of the result set, serialised. Never the whole dataset. */
  resultPreview: string;
  rowCount: number;
  truncated: boolean;
  signal?: AbortSignal;
}

export interface ProviderResponse<T> {
  value: T;
  usage: TokenUsage | null;
  /** True only for the offline demo provider. Surfaces in the UI as a label. */
  simulated: boolean;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'rate_limit' | 'timeout' | 'invalid_response' | 'unavailable',
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface AiProvider {
  readonly id: string;
  readonly simulated: boolean;
  generateSqlPlan(req: SqlPlanRequest): Promise<ProviderResponse<SqlPlan>>;
  explain(req: ExplanationRequest): Promise<ProviderResponse<string>>;
}


import { randomUUID } from 'node:crypto';
import type {
  AnalysisResponse,
  ChartSpec,
  QueryResult,
  StageName,
  StageTiming,
} from '@voicequery/shared';
import type { Db } from '../db/client.ts';
import { config } from '../config/env.ts';
import { validateSql } from '../analytics/sqlGuard.ts';
import { runAnalyticalQuery, QueryTimeoutError, DATASET_TABLE } from '../analytics/duckdb.ts';
import { loadDataset, type LoadedDataset } from '../datasets/store.ts';
import { commitCredit, InsufficientCreditsError, refundCredit, reserveCredit, getBalance } from '../credits/ledger.ts';
import { resolveProvider } from './registry.ts';
import { renderSchema } from './prompts.ts';
import { ProviderError, type SqlPlan } from './provider.ts';
import { logger, safeErrorMessage } from '../lib/logger.ts';

/**
 * The analysis pipeline.
 *
 * Ordering matters for correctness and for fairness to the user:
 *
 *   1. resolve the dataset under the caller's identity (authorisation)
 *   2. decide who pays (BYOK / platform / demo)
 *   3. reserve a credit *before* spending money on a model call
 *   4. build bounded context
 *   5. generate a structured SQL plan
 *   6. validate the SQL against the allowlist
 *   7. execute it in the sandbox
 *   8. explain the bounded results
 *   9. commit the credit, or refund it if anything after step 3 failed
 *
 * A clarification request does not complete an analysis, so it refunds. So
 * does any error. The user is only charged for a delivered answer.
 */

export class PipelineError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'dataset_not_found'
      | 'insufficient_credits'
      | 'guest_limit'
      | 'unsafe_sql'
      | 'provider'
      | 'query'
      | 'cancelled',
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

/** Analyses a guest has already run. Used for the ceiling and the nudge. */
export async function countGuestQuestions(db: Db, userId: string): Promise<number> {
  const rows = await db.query<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM messages WHERE user_id = $1 AND outcome = 'answered'`,
    [userId],
  );
  return Number(rows[0]?.n ?? 0);
}

class StageClock {
  private readonly timings: StageTiming[] = [];
  private readonly startedAt = performance.now();
  private marker = performance.now();

  finish(stage: StageName): void {
    const now = performance.now();
    this.timings.push({ stage, ms: Math.round(now - this.marker) });
    this.marker = now;
  }

  get all(): StageTiming[] {
    return this.timings;
  }

  get totalMs(): number {
    return Math.round(performance.now() - this.startedAt);
  }
}

export interface AnalyseInput {
  db: Db;
  userId: string;
  sessionScope: string;
  /** Guests are demo-only, sample-only, and capped. */
  isGuest: boolean;
  datasetId: string;
  conversationId: string | null;
  question: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}

/** Bounded conversation context: the last few turns, with answers trimmed. */
const HISTORY_TURNS = 4;
const HISTORY_ANSWER_CHARS = 400;

async function loadHistory(db: Db, conversationId: string | null, userId: string) {
  if (!conversationId) return [];
  const rows = await db.query<{ question: string; sql: string | null; answer: string }>(
    `SELECT question, sql, answer FROM messages
      WHERE conversation_id = $1 AND user_id = $2 AND outcome = 'answered'
      ORDER BY created_at DESC LIMIT $3`,
    [conversationId, userId, HISTORY_TURNS],
  );
  return rows
    .reverse()
    .map((r) => ({ ...r, answer: r.answer.slice(0, HISTORY_ANSWER_CHARS) }));
}

/**
 * Validates that the chart the model asked for actually matches the result
 * columns. A chart referencing a column that is not in the result set would
 * render blank, so we downgrade to no chart rather than show an empty axis.
 */
function buildChartSpec(plan: SqlPlan, result: QueryResult): ChartSpec | null {
  if (plan.chartKind === 'none') return null;
  if (result.rows.length === 0) return null;

  const available = new Set(result.columns);
  const xKey = available.has(plan.chartXKey) ? plan.chartXKey : result.columns[0];
  if (!xKey) return null;

  const yKeys = plan.chartYKeys.filter((k) => available.has(k) && k !== xKey);
  if (yKeys.length === 0) {
    // Fall back to the first numeric column that is not the x axis.
    const firstRow = result.rows[0]!;
    const numeric = result.columns.find(
      (c) => c !== xKey && typeof firstRow[c] === 'number',
    );
    if (!numeric) return null;
    yKeys.push(numeric);
  }

  return {
    kind: plan.chartKind,
    xKey,
    yKeys,
    title: plan.chartTitle || 'Result',
    valueFormat: plan.valueFormat,
  };
}

async function ensureConversation(
  db: Db,
  input: AnalyseInput,
  dataset: LoadedDataset,
): Promise<string> {
  if (input.conversationId) {
    const rows = await db.query<{ id: string; dataset_id: string }>(
      `SELECT id, dataset_id FROM conversations WHERE id = $1 AND user_id = $2`,
      [input.conversationId, input.userId],
    );
    const existing = rows[0];
    if (existing) {
      // A conversation is bound to the dataset it started on. Never silently
      // re-point it at a different dataset mid-thread.
      if (existing.dataset_id !== dataset.id) {
        throw new PipelineError(
          'This conversation belongs to a different dataset. Start a new conversation to switch datasets.',
          'dataset_not_found',
        );
      }
      return existing.id;
    }
  }

  const id = randomUUID();
  await db.query(
    `INSERT INTO conversations (id, user_id, dataset_id, title) VALUES ($1,$2,$3,$4)`,
    [id, input.userId, dataset.id, input.question.slice(0, 80)],
  );
  return id;
}

async function persistMessage(
  db: Db,
  conversationId: string,
  userId: string,
  response: AnalysisResponse,
): Promise<void> {
  await db.query(
    `INSERT INTO messages
       (id, conversation_id, user_id, question, outcome, answer, sql, chart_json,
        result_json, timings_json, total_ms, credit_consumed, ai_mode, usage_json,
        simulated, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      response.id,
      conversationId,
      userId,
      response.question,
      response.outcome,
      response.answer,
      response.sql,
      response.chart ? JSON.stringify(response.chart) : null,
      response.result ? JSON.stringify(response.result) : null,
      JSON.stringify(response.timings),
      response.totalMs,
      response.creditConsumed,
      response.aiMode,
      response.usage ? JSON.stringify(response.usage) : null,
      response.simulated,
      response.error,
    ],
  );
  await db.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [conversationId]);
}

export async function runAnalysis(input: AnalyseInput): Promise<AnalysisResponse> {
  const cfg = config();
  const clock = new StageClock();
  const { db, userId } = input;

  /* --- 0. guest ceiling --------------------------------------------------- */
  // Checked before anything else touches the engine, so an exhausted guest
  // costs nothing at all. The UI's nudge is dismissible; this is not.
  if (input.isGuest) {
    const used = await countGuestQuestions(db, userId);
    if (used >= cfg.GUEST_QUESTION_LIMIT) {
      throw new PipelineError(
        `The demo is limited to ${cfg.GUEST_QUESTION_LIMIT} questions. Create a free account to keep going.`,
        'guest_limit',
      );
    }
  }

  /* --- 1. dataset resolution under the caller's identity ------------------ */
  const dataset = await loadDataset(db, input.datasetId, userId);
  if (!dataset) {
    throw new PipelineError(
      'That dataset is not available. It may have expired or been deleted.',
      'dataset_not_found',
    );
  }

  // Guests cannot upload, so they should only ever reach the shared sample.
  // Enforced here too rather than relying on that: defence in depth.
  if (input.isGuest && dataset.kind !== 'sample') {
    throw new PipelineError(
      'The demo can only analyse the sample dataset. Create a free account to use your own data.',
      'dataset_not_found',
    );
  }

  const conversationId = await ensureConversation(db, input, dataset);

  /* --- 2. who pays -------------------------------------------------------- */
  const { provider, mode, consumesCredit } = resolveProvider(input.sessionScope, {
    isGuest: input.isGuest,
  });

  /* --- 3. reserve before spending ---------------------------------------- */
  let reservationId: string | null = null;
  if (consumesCredit) {
    try {
      const reservation = await reserveCredit(db, userId, input.idempotencyKey);
      reservationId = reservation.ledgerId;
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        throw new PipelineError(
          'You have used all of your free questions.',
          'insufficient_credits',
        );
      }
      throw err;
    }
  }

  const settle = async (outcome: 'commit' | 'refund', note: string) => {
    if (!reservationId) return getBalance(db, userId);
    if (outcome === 'commit') {
      await commitCredit(db, userId, reservationId);
      return getBalance(db, userId);
    }
    return refundCredit(db, userId, reservationId, note);
  };

  try {
    /* --- 4. bounded context ---------------------------------------------- */
    const history = await loadHistory(db, input.conversationId, userId);
    const schemaText = renderSchema(dataset.name, dataset.rowCount, dataset.columns);
    clock.finish('understanding');

    /* --- 5. structured generation ---------------------------------------- */
    let plan: SqlPlan;
    let planUsage;
    let simulated: boolean;
    try {
      const generated = await provider.generateSqlPlan({
        question: input.question,
        schemaText,
        history,
        signal: input.signal,
      });
      plan = generated.value;
      planUsage = generated.usage;
      simulated = generated.simulated;
    } catch (err) {
      if (err instanceof ProviderError) {
        throw new PipelineError(err.message, 'provider', err.kind);
      }
      throw err;
    }
    clock.finish('generating_sql');

    /* --- clarification: no analysis ran, so no charge -------------------- */
    if (plan.needsClarification || !plan.sql.trim()) {
      const creditsRemaining = await settle(
        'refund',
        'Clarification requested — no analysis completed',
      );
      const response: AnalysisResponse = {
        id: randomUUID(),
        conversationId,
        outcome: 'clarification',
        question: input.question,
        answer:
          plan.clarificationQuestion ||
          'Could you rephrase that? I was not able to map it to the columns in this dataset.',
        sql: null,
        chart: null,
        result: null,
        timings: clock.all,
        totalMs: clock.totalMs,
        creditConsumed: false,
        creditsRemaining,
        aiMode: mode,
        usage: planUsage,
        simulated,
        error: null,
        createdAt: new Date().toISOString(),
      };
      await persistMessage(db, conversationId, userId, response);
      return response;
    }

    /* --- 6. validate ------------------------------------------------------ */
    const verdict = validateSql(plan.sql, { allowedTables: [DATASET_TABLE] });
    if (!verdict.ok) {
      logger.warn({ code: verdict.code, datasetId: dataset.id }, 'generated SQL rejected');
      throw new PipelineError(
        'The generated query was rejected by the safety check. Please rephrase your question.',
        'unsafe_sql',
        verdict.reason,
      );
    }

    /* --- 7. sandboxed execution ------------------------------------------ */
    let result: QueryResult;
    try {
      result = await runAnalyticalQuery({
        storagePath: dataset.storagePath,
        sql: verdict.sql,
        maxRows: cfg.MAX_RESULT_ROWS,
      });
    } catch (err) {
      const message =
        err instanceof QueryTimeoutError
          ? 'The query took too long to run. Try narrowing the question.'
          : `The query could not be run: ${safeErrorMessage(err)}`;
      throw new PipelineError(message, 'query');
    }
    clock.finish('running_query');

    /* --- 8. explanation from bounded results ----------------------------- */
    const previewRows = result.rows.slice(0, cfg.MAX_EXPLAIN_ROWS);
    let answer: string;
    let explainUsage;
    try {
      const explained = await provider.explain({
        question: input.question,
        sql: verdict.sql,
        resultPreview: JSON.stringify(previewRows),
        rowCount: result.totalRows,
        truncated: result.truncated,
        signal: input.signal,
      });
      answer = explained.value;
      explainUsage = explained.usage;
    } catch (err) {
      if (err instanceof ProviderError) {
        throw new PipelineError(err.message, 'provider', err.kind);
      }
      throw err;
    }
    clock.finish('preparing_answer');

    /* --- 9. commit -------------------------------------------------------- */
    const creditsRemaining = await settle('commit', 'Analysis completed');

    const usage =
      planUsage || explainUsage
        ? {
            inputTokens: (planUsage?.inputTokens ?? 0) + (explainUsage?.inputTokens ?? 0),
            outputTokens: (planUsage?.outputTokens ?? 0) + (explainUsage?.outputTokens ?? 0),
            cacheReadInputTokens:
              (planUsage?.cacheReadInputTokens ?? 0) + (explainUsage?.cacheReadInputTokens ?? 0),
            cacheCreationInputTokens:
              (planUsage?.cacheCreationInputTokens ?? 0) +
              (explainUsage?.cacheCreationInputTokens ?? 0),
          }
        : null;

    const response: AnalysisResponse = {
      id: randomUUID(),
      conversationId,
      outcome: 'answered',
      question: input.question,
      answer,
      sql: verdict.sql,
      chart: buildChartSpec(plan, result),
      result,
      timings: clock.all,
      totalMs: clock.totalMs,
      creditConsumed: consumesCredit,
      creditsRemaining,
      aiMode: mode,
      usage,
      simulated,
      error: null,
      createdAt: new Date().toISOString(),
    };

    await persistMessage(db, conversationId, userId, response);
    logger.info(
      {
        datasetId: dataset.id,
        mode,
        totalMs: response.totalMs,
        rows: result.totalRows,
      },
      'analysis completed',
    );
    return response;
  } catch (err) {
    // Anything that fails after the reservation returns the credit.
    await settle('refund', `Analysis failed: ${err instanceof Error ? err.name : 'unknown'}`);
    throw err;
  }
}

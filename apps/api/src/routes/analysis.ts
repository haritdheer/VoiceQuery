import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AnalysisResponse, ConversationDetail, ConversationSummary } from '@voicequery/shared';
import { requireAuth, requireAuthedRequest, sendError } from '../lib/http.ts';
import { PipelineError, runAnalysis } from '../ai/pipeline.ts';
import { getBalance } from '../credits/ledger.ts';
import { logger } from '../lib/logger.ts';

const AnalyseBody = z.object({
  datasetId: z.string().min(1).max(100),
  question: z.string().trim().min(2, 'Ask a question.').max(1_000, 'That question is too long.'),
  conversationId: z.string().min(1).max(100).nullable().optional(),
  /**
   * Supplied by the client so a network retry replays rather than re-charges.
   * Generated server-side when absent, in which case every request is distinct.
   */
  idempotencyKey: z.string().min(8).max(100).optional(),
});

/** Replays the stored response for a completed idempotent request. */
async function findCompleted(
  db: Parameters<typeof getBalance>[0],
  userId: string,
  key: string,
): Promise<AnalysisResponse | null> {
  const rows = await db.query<{ status: string; response_json: string | null }>(
    `SELECT status, response_json FROM idempotency_records WHERE user_id = $1 AND key = $2`,
    [userId, key],
  );
  const row = rows[0];
  if (!row || row.status !== 'complete' || !row.response_json) return null;
  return JSON.parse(row.response_json) as AnalysisResponse;
}

export async function analysisRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/analyze', async (request, reply) => {
    const session = await requireAuthedRequest(request, reply);
    if (!session) return reply;

    const parsed = AnalyseBody.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'validation',
        parsed.error.issues[0]?.message ?? 'Invalid request.',
        'validation',
      );
    }

    const userId = session.user.id;
    const idempotencyKey = parsed.data.idempotencyKey ?? randomUUID();

    // A retry of a finished request returns the original answer verbatim and
    // charges nothing.
    const replay = await findCompleted(request.db, userId, idempotencyKey);
    if (replay) {
      return { ...replay, creditsRemaining: await getBalance(request.db, userId) };
    }

    // Claim the key. A duplicate in-flight request loses the race and is told
    // to wait rather than starting a second paid analysis.
    try {
      await request.db.query(
        `INSERT INTO idempotency_records (user_id, key, status) VALUES ($1,$2,'in_progress')`,
        [userId, idempotencyKey],
      );
    } catch {
      const settled = await findCompleted(request.db, userId, idempotencyKey);
      if (settled) {
        return { ...settled, creditsRemaining: await getBalance(request.db, userId) };
      }
      return sendError(
        reply,
        409,
        'in_progress',
        'That question is already being processed.',
      );
    }

    // Abort the provider call if the browser disconnects, so a cancelled
    // request does not keep spending tokens.
    const controller = new AbortController();
    request.raw.on('close', () => {
      if (!reply.sent) controller.abort();
    });

    try {
      const response = await runAnalysis({
        db: request.db,
        userId,
        sessionScope: userId,
        isGuest: session.user.isGuest,
        datasetId: parsed.data.datasetId,
        conversationId: parsed.data.conversationId ?? null,
        question: parsed.data.question,
        idempotencyKey,
        signal: controller.signal,
      });

      await request.db.query(
        `UPDATE idempotency_records SET status = 'complete', response_json = $3
          WHERE user_id = $1 AND key = $2`,
        [userId, idempotencyKey, JSON.stringify(response)],
      );

      return response;
    } catch (err) {
      // Release the key so the user can genuinely retry after a failure.
      await request.db.query(
        `DELETE FROM idempotency_records WHERE user_id = $1 AND key = $2`,
        [userId, idempotencyKey],
      );

      if (err instanceof PipelineError) {
        const status =
          err.code === 'insufficient_credits'
            ? 402
            : err.code === 'guest_limit'
              ? 403
              : err.code === 'dataset_not_found'
                ? 404
                : err.code === 'unsafe_sql'
                  ? 422
                  : 502;

        const code =
          err.code === 'insufficient_credits'
            ? ('insufficient_credits' as const)
            : err.code === 'guest_limit'
              ? ('guest_limit' as const)
              : err.code === 'unsafe_sql'
                ? ('unsafe_sql' as const)
                : undefined;

        return sendError(reply, status, err.code, err.message, code, {
          creditsRemaining: await getBalance(request.db, userId),
          detail: err.detail,
        });
      }

      logger.error({ err }, 'analysis failed unexpectedly');
      return sendError(
        reply,
        500,
        'internal',
        'Something went wrong running that analysis. Your credit was not charged.',
      );
    }
  });

  /* ----------------------------- conversations ---------------------------- */

  app.get('/api/conversations', async (request, reply) => {
    const session = await requireAuth(request, reply);
    if (!session) return reply;

    const rows = await request.db.query<{
      id: string;
      title: string;
      dataset_id: string;
      dataset_name: string;
      message_count: string | number;
      created_at: string | Date;
      updated_at: string | Date;
    }>(
      `SELECT c.id, c.title, c.dataset_id, d.name AS dataset_name,
              COUNT(m.id) AS message_count, c.created_at, c.updated_at
         FROM conversations c
         JOIN datasets d ON d.id = c.dataset_id
    LEFT JOIN messages m ON m.conversation_id = c.id
        WHERE c.user_id = $1
     GROUP BY c.id, c.title, c.dataset_id, d.name, c.created_at, c.updated_at
     ORDER BY c.updated_at DESC
        LIMIT 50`,
      [session.user.id],
    );

    const conversations: ConversationSummary[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      datasetId: r.dataset_id,
      datasetName: r.dataset_name,
      messageCount: Number(r.message_count),
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
    return { conversations };
  });

  app.get('/api/conversations/:id', async (request, reply) => {
    const session = await requireAuth(request, reply);
    if (!session) return reply;

    const params = z.object({ id: z.string().min(1).max(100) }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, 'validation', 'Invalid conversation id.');

    // Ownership is in the WHERE clause, so another user's conversation is a 404.
    const convRows = await request.db.query<{
      id: string;
      title: string;
      dataset_id: string;
      dataset_name: string;
      created_at: string | Date;
      updated_at: string | Date;
    }>(
      `SELECT c.id, c.title, c.dataset_id, d.name AS dataset_name, c.created_at, c.updated_at
         FROM conversations c JOIN datasets d ON d.id = c.dataset_id
        WHERE c.id = $1 AND c.user_id = $2`,
      [params.data.id, session.user.id],
    );
    const conv = convRows[0];
    if (!conv) return sendError(reply, 404, 'not_found', 'Conversation not found.');

    const msgRows = await request.db.query<Record<string, unknown>>(
      `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conv.id],
    );

    // Viewing history never consumes a credit — this is a pure read.
    const messages: AnalysisResponse[] = msgRows.map((m) => ({
      id: String(m.id),
      conversationId: String(m.conversation_id),
      outcome: m.outcome as AnalysisResponse['outcome'],
      question: String(m.question),
      answer: String(m.answer),
      sql: (m.sql as string | null) ?? null,
      chart: m.chart_json ? JSON.parse(String(m.chart_json)) : null,
      result: m.result_json ? JSON.parse(String(m.result_json)) : null,
      timings: JSON.parse(String(m.timings_json ?? '[]')),
      totalMs: Number(m.total_ms ?? 0),
      creditConsumed: Boolean(m.credit_consumed),
      creditsRemaining: 0,
      aiMode: m.ai_mode as AnalysisResponse['aiMode'],
      usage: m.usage_json ? JSON.parse(String(m.usage_json)) : null,
      simulated: Boolean(m.simulated),
      error: (m.error as string | null) ?? null,
      createdAt: new Date(m.created_at as string).toISOString(),
    }));

    const detail: ConversationDetail = {
      id: conv.id,
      title: conv.title,
      datasetId: conv.dataset_id,
      datasetName: conv.dataset_name,
      messageCount: messages.length,
      createdAt: new Date(conv.created_at).toISOString(),
      updatedAt: new Date(conv.updated_at).toISOString(),
      messages,
    };
    return { conversation: detail };
  });
}

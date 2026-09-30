import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import type { AppConfigResponse } from '@voicequery/shared';
import { config } from './config/env.ts';
import { type Db } from './db/client.ts';
import { migrate } from './db/migrate.ts';
import { ensureSampleDataset, sweepExpiredDatasets } from './datasets/store.ts';
import { sweepExpiredGuests, sweepExpiredSessions } from './auth/session.ts';
import { sweepExpiredKeys } from './byok/keyStore.ts';
import { SUPPORTED_PROVIDERS } from './ai/providers.ts';
import { authRoutes } from './routes/auth.ts';
import { datasetRoutes } from './routes/datasets.ts';
import { analysisRoutes } from './routes/analysis.ts';
import { creditRoutes } from './routes/credits.ts';
import { byokRoutes } from './routes/byok.ts';
import { billingConfig, billingRoutes } from './routes/billing.ts';
import { logger, safeErrorMessage } from './lib/logger.ts';
import { sendError } from './lib/http.ts';

export interface BuildOptions {
  db: Db;
  /** Skip migrations and seeding when the caller has already prepared the db. */
  skipBootstrap?: boolean;
}

export async function buildApp(options: BuildOptions) {
  const cfg = config();
  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    bodyLimit: cfg.MAX_UPLOAD_BYTES + 1024 * 1024,
    trustProxy: cfg.isProd,
  });

  if (!options.skipBootstrap) {
    await migrate(options.db);
    await ensureSampleDataset(options.db);
  }

  /**
   * Preserve the raw JSON body. Stripe signature verification must hash the
   * exact bytes that were sent, so a re-serialised object will not verify.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      (req as FastifyRequest & { rawBody?: Buffer }).rawBody = body;
      if (body.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        (err as Error & { statusCode?: number }).statusCode = 400;
        done(err as Error);
      }
    },
  );

  await app.register(cors, {
    origin: cfg.corsOrigins,
    // Required so the browser sends the session cookie cross-origin.
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key'],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });

  await app.register(cookie, { secret: cfg.SESSION_SECRET });

  await app.register(multipart, {
    limits: { fileSize: cfg.MAX_UPLOAD_BYTES, files: 1, fields: 5 },
  });

  await app.register(rateLimit, {
    global: true,
    max: cfg.RATE_LIMIT_GLOBAL_PER_MINUTE,
    timeWindow: '1 minute',
    // Authenticated users are limited per account; anonymous traffic per IP.
    keyGenerator: (req) => req.session?.user.id ?? req.ip,
  });

  // Make the db handle available to every route.
  // Decorated as a null placeholder; the onRequest hook below sets the real handle.
  app.decorateRequest('db', null as unknown as Db);
  app.addHook('onRequest', async (request) => {
    request.db = options.db;
  });

  /* ------------------------------- routes -------------------------------- */

  app.get('/api/health', async () => ({
    status: 'ok',
    driver: options.db.driver,
    demoMode: cfg.demoMode,
  }));

  app.get('/api/config', async (): Promise<AppConfigResponse> => {
    return {
      demoMode: cfg.demoMode,
      billing: billingConfig(),
      providers: SUPPORTED_PROVIDERS,
      limits: {
        maxUploadBytes: cfg.MAX_UPLOAD_BYTES,
        maxRows: cfg.MAX_ROWS,
        maxColumns: cfg.MAX_COLUMNS,
        maxResultRows: cfg.MAX_RESULT_ROWS,
        datasetTtlHours: cfg.DATASET_TTL_HOURS,
      },
      freeCredits: cfg.FREE_CREDITS,
      // A free demo deployment never charges, so the client must not promise
      // "N free questions".
      creditsEnabled: !cfg.demoMode || cfg.DEMO_CONSUMES_CREDITS,
      guest: {
        enabled: cfg.GUEST_MODE_ENABLED,
        nudgeAfter: cfg.GUEST_NUDGE_AFTER,
        nudgeEvery: cfg.GUEST_NUDGE_EVERY,
        questionsLimit: cfg.GUEST_QUESTION_LIMIT,
      },
    };
  });

  await app.register(authRoutes);
  await app.register(datasetRoutes);

  // Analysis and upload carry their own tighter limits on top of the global
  // one, because each costs real money or real disk.
  await app.register(async (scoped) => {
    await scoped.register(rateLimit, {
      max: cfg.RATE_LIMIT_ANALYSIS_PER_HOUR,
      timeWindow: '1 hour',
      keyGenerator: (req) => req.session?.user.id ?? req.ip,
    });
    await scoped.register(analysisRoutes);
  });

  await app.register(creditRoutes);
  await app.register(byokRoutes);
  await app.register(billingRoutes);

  /* --------------------------- error handling ---------------------------- */

  app.setNotFoundHandler((request, reply) =>
    sendError(reply, 404, 'not_found', `No route for ${request.method} ${request.url}.`),
  );

  app.setErrorHandler((error: unknown, request, reply) => {
    const e = error as { statusCode?: number; code?: string };
    const status = e.statusCode ?? 500;

    if (status === 429) {
      return sendError(
        reply,
        429,
        'rate_limited',
        'Too many requests. Please slow down and try again shortly.',
        'rate_limited',
      );
    }
    if (status === 413) {
      return sendError(reply, 413, 'too_large', 'That upload is too large.', 'validation');
    }
    if (status < 500) {
      return sendError(reply, status, e.code ?? 'bad_request', safeErrorMessage(error));
    }

    // Log the full error with a request id; return a generic message.
    request.log.error({ err: error, reqId: request.id }, 'unhandled error');
    return sendError(
      reply,
      500,
      'internal',
      'Something went wrong. Please try again.',
      undefined,
      { requestId: request.id },
    );
  });

  /* ------------------------------ background ----------------------------- */

  if (!cfg.isTest) {
    const sweep = setInterval(
      () => {
        void (async () => {
          try {
            await sweepExpiredDatasets(options.db);
            await sweepExpiredSessions(options.db);
            await sweepExpiredGuests(options.db);
            sweepExpiredKeys();
          } catch (err) {
            logger.warn({ err: safeErrorMessage(err) }, 'sweep failed');
          }
        })();
      },
      15 * 60 * 1000,
    );
    sweep.unref();
    app.addHook('onClose', async () => clearInterval(sweep));
  }

  return app;
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config/env.ts';
import { requireAccount, requireAuth, requireAuthedRequest, sendError } from '../lib/http.ts';
import {
  createDatasetFromCsv,
  deleteDataset,
  listDatasets,
  loadDataset,
} from '../datasets/store.ts';
import { CsvValidationError } from '../datasets/csv.ts';
import { SAMPLE_QUESTIONS } from '../datasets/sample.ts';
import { safeErrorMessage } from '../lib/logger.ts';

const IdParams = z.object({ id: z.string().min(1).max(100) });

export async function datasetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/datasets', async (request, reply) => {
    const session = await requireAuth(request, reply);
    if (!session) return reply;
    return { datasets: await listDatasets(request.db, session.user.id) };
  });

  app.get('/api/datasets/:id', async (request, reply) => {
    const session = await requireAuth(request, reply);
    if (!session) return reply;

    const params = IdParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, 'validation', 'Invalid dataset id.');

    // loadDataset filters on ownership; another user's id returns null and is
    // reported as 404 so the existence of their data is not disclosed.
    const dataset = await loadDataset(request.db, params.data.id, session.user.id);
    if (!dataset) {
      return sendError(reply, 404, 'not_found', 'That dataset is not available.');
    }

    const { storagePath: _storagePath, ownerId: _ownerId, ...safe } = dataset;
    return {
      dataset: safe,
      exampleQuestions: dataset.kind === 'sample' ? SAMPLE_QUESTIONS : [],
    };
  });

  // Uploads get their own, tighter limit on top of the global one: each one
  // costs disk and CPU to ingest.
  app.post(
    '/api/datasets',
    {
      config: {
        rateLimit: {
          max: config().RATE_LIMIT_UPLOAD_PER_HOUR,
          timeWindow: '1 hour',
        },
      },
    },
    async (request, reply) => {
      // Guests cannot upload: storage is a real cost and an anonymous
      // visitor has nothing at stake.
      const session = await requireAccount(request, reply, 'upload your own data');
      if (!session) return reply;

      const cfg = config();
      const file = await request.file({ limits: { fileSize: cfg.MAX_UPLOAD_BYTES, files: 1 } });
      if (!file) {
        return sendError(reply, 400, 'validation', 'Attach a CSV file to upload.', 'validation');
      }

      const filename = file.filename ?? 'upload.csv';
      if (!/\.csv$/i.test(filename)) {
        return sendError(
          reply,
          400,
          'validation',
          'Only .csv files are supported.',
          'validation',
        );
      }

      let content: string;
      try {
        const buffer = await file.toBuffer();
        content = buffer.toString('utf8');
      } catch (err) {
        // Thrown by @fastify/multipart when the stream exceeds fileSize.
        if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          return sendError(
            reply,
            413,
            'too_large',
            `That file is larger than the ${(cfg.MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MB limit.`,
            'validation',
          );
        }
        throw err;
      }

      try {
        // createDatasetFromCsv returns a DatasetDetail, which by construction
        // carries no storage path — nothing internal to strip here.
        const dataset = await createDatasetFromCsv({
          db: request.db,
          userId: session.user.id,
          name: filename.replace(/\.csv$/i, '').slice(0, 120),
          content,
        });
        return reply.status(201).send({ dataset });
      } catch (err) {
        if (err instanceof CsvValidationError) {
          return sendError(reply, 422, 'invalid_csv', err.message, 'validation', {
            hint: err.hint,
          });
        }
        // Never echo file contents back in an error.
        return sendError(
          reply,
          500,
          'upload_failed',
          `The file could not be processed: ${safeErrorMessage(err)}`,
        );
      }
    },
  );

  app.delete('/api/datasets/:id', async (request, reply) => {
    const session = await requireAccount(request, reply, 'manage datasets');
    if (!session) return reply;

    const params = IdParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, 'validation', 'Invalid dataset id.');

    const deleted = await deleteDataset(request.db, params.data.id, session.user.id);
    if (!deleted) {
      return sendError(
        reply,
        404,
        'not_found',
        'That dataset could not be deleted. The built-in sample cannot be removed.',
      );
    }
    return { deleted: true };
  });
}

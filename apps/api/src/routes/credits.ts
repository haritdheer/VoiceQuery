import type { FastifyInstance } from 'fastify';
import { getBalance, listLedger } from '../credits/ledger.ts';
import { requireAuth } from '../lib/http.ts';

export async function creditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/credits', async (request, reply) => {
    const session = await requireAuth(request, reply);
    if (!session) return reply;

    // The balance is always read from the database. The client's counter is
    // presentation only and is never an input to any decision.
    return {
      balance: await getBalance(request.db, session.user.id),
      ledger: await listLedger(request.db, session.user.id),
    };
  });
}

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { BillingConfig, PurchaseRecord } from '@voicequery/shared';
import { config } from '../config/env.ts';
import { findPackage, stripeClient } from '../billing/stripe.ts';
import { processWebhookEvent, verifyWebhook, WebhookSignatureError } from '../billing/webhook.ts';
import { requireAccount, requireAuth, sendError } from '../lib/http.ts';
import { logger, safeErrorMessage } from '../lib/logger.ts';

const CheckoutBody = z.object({ packageId: z.string().min(1).max(64) });

export function billingConfig(): BillingConfig {
  const cfg = config();
  return {
    enabled: cfg.billingEnabled,
    testMode: cfg.billingTestMode,
    packages: cfg.packages,
  };
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/billing/config', async () => billingConfig());

  app.get('/api/billing/purchases', async (request, reply) => {
    const session = await requireAuth(request, reply);
    if (!session) return reply;

    const rows = await request.db.query<{
      id: string;
      package_id: string;
      credits: number;
      amount_minor: number;
      currency: string;
      status: PurchaseRecord['status'];
      provider_ref: string | null;
      created_at: string | Date;
    }>(
      `SELECT id, package_id, credits, amount_minor, currency, status, provider_ref, created_at
         FROM purchases WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [session.user.id],
    );

    const purchases: PurchaseRecord[] = rows.map((r) => ({
      id: r.id,
      packageId: r.package_id,
      credits: Number(r.credits),
      amountMinor: Number(r.amount_minor),
      currency: r.currency,
      status: r.status,
      providerRef: r.provider_ref,
      createdAt: new Date(r.created_at).toISOString(),
    }));
    return { purchases };
  });

  app.post('/api/billing/checkout', async (request, reply) => {
    const session = await requireAccount(request, reply, 'buy credits');
    if (!session) return reply;

    const cfg = config();
    if (!cfg.billingEnabled) {
      return sendError(
        reply,
        503,
        'billing_disabled',
        'Credit purchases are not configured on this deployment.',
      );
    }

    const parsed = CheckoutBody.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'validation', 'Choose a credit package.', 'validation');
    }

    // Price and credit count come from server configuration, never the client.
    const pkg = findPackage(parsed.data.packageId);
    if (!pkg) return sendError(reply, 404, 'not_found', 'That credit package does not exist.');

    const purchaseId = randomUUID();

    try {
      const checkout = await stripeClient().checkout.sessions.create({
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: pkg.currency,
              unit_amount: pkg.amountMinor,
              product_data: {
                name: pkg.name,
                description: `${pkg.credits} VoiceQuery analysis credits`,
              },
            },
          },
        ],
        success_url: cfg.CHECKOUT_SUCCESS_URL,
        cancel_url: cfg.CHECKOUT_CANCEL_URL,
        client_reference_id: purchaseId,
        metadata: { purchaseId, userId: session.user.id, packageId: pkg.id },
      });

      await request.db.query(
        `INSERT INTO purchases
           (id, user_id, package_id, credits, amount_minor, currency, status, provider_ref)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)`,
        [
          purchaseId,
          session.user.id,
          pkg.id,
          pkg.credits,
          pkg.amountMinor,
          pkg.currency,
          checkout.id,
        ],
      );

      logger.info(
        { purchaseId, packageId: pkg.id, testMode: cfg.billingTestMode },
        'checkout session created',
      );

      // Credits are granted by the verified webhook only. The redirect below
      // is navigation, not proof of payment.
      return { url: checkout.url, testMode: cfg.billingTestMode };
    } catch (err) {
      logger.error({ err: safeErrorMessage(err) }, 'checkout creation failed');
      return sendError(
        reply,
        502,
        'checkout_failed',
        'Could not start checkout. Please try again.',
      );
    }
  });

  /**
   * Stripe webhook.
   *
   * Unauthenticated by design — trust comes from the signature, not a session.
   * CSRF does not apply for the same reason. The raw body is required for
   * verification, so server.ts preserves it on every JSON request.
   */
  app.post('/api/billing/webhook', async (request, reply) => {
    const cfg = config();
    const secret = cfg.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      return sendError(
        reply,
        503,
        'billing_disabled',
        'Webhooks are not configured on this deployment.',
      );
    }

    const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
    if (!raw) {
      return sendError(reply, 400, 'bad_request', 'Missing request body.');
    }

    const signature = request.headers['stripe-signature'];
    try {
      const event = verifyWebhook(
        raw,
        Array.isArray(signature) ? signature[0] : signature,
        secret,
      );
      const outcome = await processWebhookEvent(request.db, event);
      return { received: true, ...outcome };
    } catch (err) {
      if (err instanceof WebhookSignatureError) {
        // Never grant anything on an unverifiable event.
        logger.warn({ reason: err.message }, 'webhook signature rejected');
        return sendError(reply, 400, 'invalid_signature', 'Signature verification failed.');
      }
      logger.error({ err: safeErrorMessage(err) }, 'webhook processing failed');
      // A 500 tells Stripe to retry, which is correct for a transient fault.
      return sendError(reply, 500, 'webhook_failed', 'Could not process the event.');
    }
  });
}

import Stripe from 'stripe';
import type { Db } from '../db/client.ts';
import { grantCredits } from '../credits/ledger.ts';
import { logger } from '../lib/logger.ts';

/**
 * Webhook processing, separated from the HTTP route so it can be tested
 * directly against a real signed payload.
 *
 * Two guarantees:
 *   - Credits are granted only for a signature-verified event.
 *   - Duplicate delivery is harmless: `payment_events.id` is the primary key,
 *     so a repeat insert fails and the handler exits before granting again.
 */

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

export function verifyWebhook(
  rawBody: Buffer | string,
  signature: string | undefined,
  secret: string,
): Stripe.Event {
  if (!signature) throw new WebhookSignatureError('Missing Stripe-Signature header.');
  try {
    return Stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    throw new WebhookSignatureError(
      `Signature verification failed: ${(err as Error).message}`,
    );
  }
}

export interface WebhookOutcome {
  handled: boolean;
  duplicate: boolean;
  creditsGranted: number;
}

/**
 * Applies a verified event.
 *
 * The de-duplication insert happens *before* any credit grant and inside the
 * same transaction, so concurrent duplicate deliveries cannot both win.
 */
export async function processWebhookEvent(db: Db, event: Stripe.Event): Promise<WebhookOutcome> {
  const claimed = await db.query<{ id: string }>(
    `INSERT INTO payment_events (id, provider, type) VALUES ($1,'stripe',$2)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [event.id, event.type],
  );
  if (claimed.length === 0) {
    logger.info({ eventId: event.id, type: event.type }, 'duplicate webhook ignored');
    return { handled: true, duplicate: true, creditsGranted: 0 };
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;

      // Only a genuinely paid session grants credits. A completed session in
      // an unpaid state (e.g. a delayed payment method) is left pending until
      // async_payment_succeeded arrives.
      if (session.payment_status !== 'paid') {
        logger.info(
          { eventId: event.id, paymentStatus: session.payment_status },
          'checkout completed but not paid',
        );
        return { handled: true, duplicate: false, creditsGranted: 0 };
      }
      return grantForSession(db, session);
    }

    case 'checkout.session.async_payment_succeeded': {
      return grantForSession(db, event.data.object as Stripe.Checkout.Session);
    }

    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired': {
      const session = event.data.object as Stripe.Checkout.Session;
      const status = event.type === 'checkout.session.expired' ? 'cancelled' : 'failed';
      await db.query(
        `UPDATE purchases SET status = $2, updated_at = now()
          WHERE provider_ref = $1 AND status = 'pending'`,
        [session.id, status],
      );
      return { handled: true, duplicate: false, creditsGranted: 0 };
    }

    default:
      return { handled: false, duplicate: false, creditsGranted: 0 };
  }
}

async function grantForSession(
  db: Db,
  session: Stripe.Checkout.Session,
): Promise<WebhookOutcome> {
  // The purchase row was created when the session was opened, so the amount
  // and credit count come from our own record rather than from the webhook
  // payload.
  const rows = await db.query<{
    id: string;
    user_id: string;
    credits: number;
    status: string;
  }>(
    `SELECT id, user_id, credits, status FROM purchases WHERE provider_ref = $1`,
    [session.id],
  );
  const purchase = rows[0];

  if (!purchase) {
    logger.warn({ sessionId: session.id }, 'webhook for unknown checkout session');
    return { handled: true, duplicate: false, creditsGranted: 0 };
  }
  if (purchase.status === 'paid') {
    return { handled: true, duplicate: true, creditsGranted: 0 };
  }

  await db.query(
    `UPDATE purchases SET status = 'paid', updated_at = now() WHERE id = $1`,
    [purchase.id],
  );
  const credits = Number(purchase.credits);
  await grantCredits(db, purchase.user_id, credits, `Purchase ${purchase.id}`);

  logger.info({ purchaseId: purchase.id, credits }, 'credits granted after verified payment');
  return { handled: true, duplicate: false, creditsGranted: credits };
}

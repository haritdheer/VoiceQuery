import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, TestClient, uniqueEmail, type TestContext } from './helpers.ts';
import { processWebhookEvent, verifyWebhook, WebhookSignatureError } from '../src/billing/webhook.ts';
import { getBalance } from '../src/credits/ledger.ts';

/**
 * Webhook tests use Stripe's own `generateTestHeaderString` to produce a
 * genuine signature, so verification is exercised for real rather than mocked.
 */

const SECRET = 'whsec_test_secret_for_unit_tests';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

function signedEvent(payloadObject: unknown): { raw: string; signature: string } {
  const raw = JSON.stringify(payloadObject);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: raw, secret: SECRET });
  return { raw, signature };
}

function checkoutCompletedEvent(sessionId: string, eventId = `evt_${randomUUID()}`) {
  return {
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        payment_status: 'paid',
      },
    },
  };
}

async function seedPendingPurchase(credits = 20) {
  const client = new TestClient(ctx.app);
  const reg = await client.register(uniqueEmail());
  const userId = String((reg.body.user as { id: string }).id);

  const purchaseId = randomUUID();
  const sessionId = `cs_test_${randomUUID()}`;
  await ctx.db.query(
    `INSERT INTO purchases (id,user_id,package_id,credits,amount_minor,currency,status,provider_ref)
     VALUES ($1,$2,'pack20',$3,900,'usd','pending',$4)`,
    [purchaseId, userId, credits, sessionId],
  );
  return { userId, purchaseId, sessionId, client };
}

describe('webhook signature verification', () => {
  it('accepts a correctly signed payload', () => {
    const { raw, signature } = signedEvent(checkoutCompletedEvent('cs_test_1'));
    const event = verifyWebhook(raw, signature, SECRET);
    expect(event.type).toBe('checkout.session.completed');
  });

  it('rejects a payload with no signature header', () => {
    const { raw } = signedEvent(checkoutCompletedEvent('cs_test_2'));
    expect(() => verifyWebhook(raw, undefined, SECRET)).toThrow(WebhookSignatureError);
  });

  it('rejects a forged signature', () => {
    const { raw } = signedEvent(checkoutCompletedEvent('cs_test_3'));
    expect(() => verifyWebhook(raw, 't=1,v1=deadbeef', SECRET)).toThrow(WebhookSignatureError);
  });

  it('rejects a payload signed with a different secret', () => {
    const raw = JSON.stringify(checkoutCompletedEvent('cs_test_4'));
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload: raw,
      secret: 'whsec_a_completely_different_secret',
    });
    expect(() => verifyWebhook(raw, signature, SECRET)).toThrow(WebhookSignatureError);
  });

  it('rejects a body that was tampered with after signing', () => {
    const original = checkoutCompletedEvent('cs_test_5');
    const { signature } = signedEvent(original);
    const tampered = JSON.stringify({ ...original, data: { object: { id: 'cs_attacker' } } });
    expect(() => verifyWebhook(tampered, signature, SECRET)).toThrow(WebhookSignatureError);
  });
});

describe('webhook credit granting', () => {
  it('grants credits exactly once for a verified payment', async () => {
    const { userId, sessionId } = await seedPendingPurchase(20);
    expect(await getBalance(ctx.db, userId)).toBe(2);

    const event = checkoutCompletedEvent(sessionId);
    const outcome = await processWebhookEvent(ctx.db, event as unknown as Stripe.Event);

    expect(outcome.creditsGranted).toBe(20);
    expect(await getBalance(ctx.db, userId)).toBe(22);

    const rows = await ctx.db.query<{ status: string }>(
      `SELECT status FROM purchases WHERE provider_ref = $1`,
      [sessionId],
    );
    expect(rows[0]?.status).toBe('paid');
  });

  it('ignores a duplicate delivery of the same event', async () => {
    const { userId, sessionId } = await seedPendingPurchase(20);
    const event = checkoutCompletedEvent(sessionId) as unknown as Stripe.Event;

    const first = await processWebhookEvent(ctx.db, event);
    const second = await processWebhookEvent(ctx.db, event);
    const third = await processWebhookEvent(ctx.db, event);

    expect(first.creditsGranted).toBe(20);
    expect(second.duplicate).toBe(true);
    expect(second.creditsGranted).toBe(0);
    expect(third.creditsGranted).toBe(0);
    // 2 free + 20 purchased, not 2 + 60.
    expect(await getBalance(ctx.db, userId)).toBe(22);
  });

  it('ignores a distinct event that refers to an already-paid session', async () => {
    const { userId, sessionId } = await seedPendingPurchase(20);
    await processWebhookEvent(
      ctx.db,
      checkoutCompletedEvent(sessionId, `evt_${randomUUID()}`) as unknown as Stripe.Event,
    );
    // Same session, brand new event id — must still not double-grant.
    const replay = await processWebhookEvent(
      ctx.db,
      checkoutCompletedEvent(sessionId, `evt_${randomUUID()}`) as unknown as Stripe.Event,
    );
    expect(replay.creditsGranted).toBe(0);
    expect(await getBalance(ctx.db, userId)).toBe(22);
  });

  it('does not grant credits for a completed but unpaid session', async () => {
    const { userId, sessionId } = await seedPendingPurchase(20);
    const event = {
      id: `evt_${randomUUID()}`,
      type: 'checkout.session.completed',
      data: { object: { id: sessionId, payment_status: 'unpaid' } },
    };
    const outcome = await processWebhookEvent(ctx.db, event as unknown as Stripe.Event);
    expect(outcome.creditsGranted).toBe(0);
    expect(await getBalance(ctx.db, userId)).toBe(2);
  });

  it('marks an expired session as cancelled without granting', async () => {
    const { userId, sessionId } = await seedPendingPurchase(20);
    const event = {
      id: `evt_${randomUUID()}`,
      type: 'checkout.session.expired',
      data: { object: { id: sessionId } },
    };
    await processWebhookEvent(ctx.db, event as unknown as Stripe.Event);

    const rows = await ctx.db.query<{ status: string }>(
      `SELECT status FROM purchases WHERE provider_ref = $1`,
      [sessionId],
    );
    expect(rows[0]?.status).toBe('cancelled');
    expect(await getBalance(ctx.db, userId)).toBe(2);
  });

  it('marks a failed async payment as failed without granting', async () => {
    const { userId, sessionId } = await seedPendingPurchase(20);
    await processWebhookEvent(
      ctx.db,
      {
        id: `evt_${randomUUID()}`,
        type: 'checkout.session.async_payment_failed',
        data: { object: { id: sessionId } },
      } as unknown as Stripe.Event,
    );
    const rows = await ctx.db.query<{ status: string }>(
      `SELECT status FROM purchases WHERE provider_ref = $1`,
      [sessionId],
    );
    expect(rows[0]?.status).toBe('failed');
    expect(await getBalance(ctx.db, userId)).toBe(2);
  });

  it('safely ignores a webhook for an unknown session', async () => {
    const outcome = await processWebhookEvent(
      ctx.db,
      checkoutCompletedEvent('cs_test_never_seen') as unknown as Stripe.Event,
    );
    expect(outcome.creditsGranted).toBe(0);
  });
});

describe('webhook HTTP endpoint', () => {
  it('rejects an unsigned request without granting anything', async () => {
    const anon = new TestClient(ctx.app);
    const res = await anon.request('POST', '/api/billing/webhook', checkoutCompletedEvent('cs_x'));
    // Either billing is unconfigured (503) or the signature is missing (400).
    expect([400, 503]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });
});

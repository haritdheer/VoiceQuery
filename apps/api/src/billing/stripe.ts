import Stripe from 'stripe';
import { config } from '../config/env.ts';
import type { CreditPackage } from '@voicequery/shared';

/**
 * Stripe integration.
 *
 * Everything price-related is server-side. The browser sends a package *id*
 * and nothing else; amount, currency and credit count are looked up from the
 * operator's configuration, so a tampered request cannot buy 1,000 credits
 * for one cent.
 */

let client: Stripe | null = null;

export function stripeClient(): Stripe {
  const key = config().STRIPE_SECRET_KEY;
  if (!key) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY is unset).');
  client ??= new Stripe(key, { maxNetworkRetries: 2 });
  return client;
}

/** Test helper so a test can inject a client without real credentials. */
export function __setStripeClientForTests(c: Stripe | null): void {
  client = c;
}

export function findPackage(packageId: string): CreditPackage | null {
  return config().packages.find((p) => p.id === packageId) ?? null;
}

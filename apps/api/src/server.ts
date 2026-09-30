import { buildApp } from './app.ts';
import { config } from './config/env.ts';
import { closeDb, getDb } from './db/client.ts';
import { closeAllInstances } from './analytics/duckdb.ts';
import { logger } from './lib/logger.ts';

const cfg = config();
const db = await getDb();
const app = await buildApp({ db });

try {
  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  logger.info(
    {
      port: cfg.PORT,
      driver: db.driver,
      demoMode: cfg.demoMode,
      billing: cfg.billingEnabled ? (cfg.billingTestMode ? 'test mode' : 'LIVE') : 'disabled',
    },
    'VoiceQuery API listening',
  );
  if (cfg.demoMode) {
    logger.warn(
      'No ANTHROPIC_API_KEY set — answers come from the offline demo provider and are labelled as simulated.',
    );
  }
} catch (err) {
  logger.error({ err }, 'failed to start');
  process.exit(1);
}

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  try {
    await app.close();
    closeAllInstances();
    await closeDb();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

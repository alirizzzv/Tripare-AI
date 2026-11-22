import { createApp } from './app';
import { getEnv } from '../config/env';
import { logger } from '../lib/logger';
import { closeRedis } from '../lib/redis';
import { closeTemporalClient } from '../lib/temporalClient';

const env = getEnv();
const app = createApp({ env });

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, chaosEnabled: env.ENABLE_CHAOS }, 'api listening');
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, 'shutting down api (finishing in-flight requests)');

  // Hard stop if draining takes too long (Docker sends SIGKILL after 10s by default).
  setTimeout(() => {
    logger.error('graceful shutdown timed out');
    process.exit(1);
  }, 9_000).unref();

  // Stop accepting connections first, then close shared clients once requests are done.
  server.close((err) => {
    void (async () => {
      if (err) {
        logger.error({ err }, 'error during server close');
      }
      await Promise.allSettled([closeRedis(), closeTemporalClient()]);
      logger.info('api stopped');
      process.exit(err ? 1 : 0);
    })();
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

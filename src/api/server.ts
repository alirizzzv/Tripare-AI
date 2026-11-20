import { createApp } from './app';
import { getEnv } from '../config/env';
import { logger } from '../lib/logger';

const env = getEnv();
const app = createApp({ env });

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'api listening');
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close((err) => {
    if (err) {
      logger.error({ err }, 'error during server close');
      process.exit(1);
    }
    process.exit(0);
  });
  setTimeout(() => {
    logger.error('graceful shutdown timed out');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

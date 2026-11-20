import fs from 'node:fs';
import path from 'node:path';
import { NativeConnection, Worker } from '@temporalio/worker';
import { getEnv } from '../config/env';
import { logger } from '../lib/logger';
import { closeRedis, getRedis } from '../lib/redis';
import { createActivities } from './activities';

async function connectWithRetry(
  address: string,
  maxAttempts = 15,
  delayMs = 2000,
): Promise<NativeConnection> {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      logger.info({ address, attempt: attempt + 1 }, 'connecting to Temporal server...');
      return await NativeConnection.connect({ address });
    } catch (err) {
      attempt++;
      if (attempt >= maxAttempts) {
        throw err;
      }
      logger.warn(
        { address, attempt, err: err instanceof Error ? err.message : String(err) },
        `Temporal not ready yet, retrying in ${delayMs}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`Failed to connect to Temporal at ${address} after ${maxAttempts} attempts`);
}

function resolveWorkflowsPath(): string {
  const tsPath = path.join(__dirname, 'workflows.ts');
  const jsPath = path.join(__dirname, 'workflows.js');
  if (fs.existsSync(tsPath)) {
    return tsPath;
  }
  if (fs.existsSync(jsPath)) {
    return jsPath;
  }
  // Fallback to module resolution
  return require.resolve('./workflows');
}

export async function runWorker(): Promise<void> {
  const env = getEnv();
  const redis = getRedis();
  const connection = await connectWithRetry(env.TEMPORAL_ADDRESS);
  const workflowsPath = resolveWorkflowsPath();

  const activities = createActivities({
    config: env,
    redis,
    logger,
  });

  const worker = await Worker.create({
    connection,
    namespace: env.TEMPORAL_NAMESPACE,
    taskQueue: env.TEMPORAL_TASK_QUEUE,
    workflowsPath,
    activities,
  });

  logger.info(
    {
      taskQueue: env.TEMPORAL_TASK_QUEUE,
      namespace: env.TEMPORAL_NAMESPACE,
      workflowsPath,
    },
    'temporal worker started, listening for workflow tasks',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down temporal worker...');
    worker.shutdown();
    await closeRedis();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await worker.run();
  await connection.close();
  logger.info('temporal worker stopped');
}

if (require.main === module) {
  runWorker().catch((err) => {
    logger.error({ err }, 'fatal error in temporal worker');
    process.exit(1);
  });
}

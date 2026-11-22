import { Router, type Request, type Response } from 'express';
import type Redis from 'ioredis';
import { getEnv, type Env } from '../../config/env';
import { logger } from '../../lib/logger';
import { getRedis } from '../../lib/redis';
import { getTemporalClient } from '../../lib/temporalClient';

/**
 * HEALTH ENDPOINT ARCHITECTURAL POLICY (Decision 12, Invariant I10):
 *
 * Docker and container orchestration MUST use GET /ping for liveness/healthchecks,
 * NEVER /health.
 *
 * Reason: /health reports "down" (HTTP 503) when no worker is actively polling the task queue.
 * Using /health for depends_on or container healthcheck creates a startup deadlock:
 * the worker depends on the API, but the API would report unhealthy until the worker is polling.
 * /health is intended for humans, synthetic monitors, and deployment readiness gates.
 * It is completely isolated in a top-level try/catch and never throws or leaks stack traces.
 */

export type DependencyHealth = {
  status: 'ok' | 'down';
  latencyMs?: number;
  error?: string;
};

export type HealthResponse = {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  uptimeSeconds: number;
  dependencies: {
    supplierA: DependencyHealth;
    supplierB: DependencyHealth;
    redis: DependencyHealth;
    temporal: DependencyHealth & { workerPolling?: { status: 'ok' | 'down'; pollersCount: number } };
  };
};

export type HealthCheckDependencies = {
  env?: Env;
  redis?: Redis;
  fetchFn?: typeof fetch;
  temporalClient?:
    | ReturnType<typeof getTemporalClient>
    | (() => ReturnType<typeof getTemporalClient>);
};

class HealthTimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'TimeoutError';
  }
}

/**
 * Invariant I10/I13: /health is public, so it reports a short fixed vocabulary instead of raw
 * error messages (which can contain internal hostnames/IPs). Full errors go to the logs.
 */
function publicError(err: unknown): 'timeout' | 'unreachable' {
  const isTimeout =
    err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
  return isTimeout ? 'timeout' : 'unreachable';
}

async function checkRedisHealth(redis: Redis, timeoutMs = 1000): Promise<DependencyHealth> {
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const pingPromise = redis.ping();
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HealthTimeoutError()), timeoutMs);
    });
    const result = await Promise.race([pingPromise, timeoutPromise]);
    const latencyMs = Date.now() - start;
    if (result === 'PONG') {
      return { status: 'ok', latencyMs };
    }
    return { status: 'down', latencyMs, error: 'unexpected response' };
  } catch (err) {
    logger.warn({ err }, 'health: redis check failed');
    return { status: 'down', latencyMs: Date.now() - start, error: publicError(err) };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function checkSupplierHealth(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs = 1000,
): Promise<DependencyHealth> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    const latencyMs = Date.now() - start;

    if (response.ok) {
      return { status: 'ok', latencyMs };
    }
    return { status: 'down', latencyMs, error: `HTTP ${response.status}` };
  } catch (err) {
    clearTimeout(timer);
    return { status: 'down', latencyMs: Date.now() - start, error: publicError(err) };
  }
}

async function checkTemporalHealth(
  env: Env,
  clientOrFn: ReturnType<typeof getTemporalClient> | (() => ReturnType<typeof getTemporalClient>),
  timeoutMs = 1000,
): Promise<DependencyHealth & { workerPolling: { status: 'ok' | 'down'; pollersCount: number } }> {
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    // WHY: the timeout covers connecting AND describeTaskQueue; a hung first connect must not
    // make /health hang (rejected: timing only the describe call).
    const describe = async () => {
      const client = typeof clientOrFn === 'function' ? await clientOrFn() : await clientOrFn;
      return client.workflowService.describeTaskQueue({
        namespace: env.TEMPORAL_NAMESPACE,
        taskQueue: { name: env.TEMPORAL_TASK_QUEUE },
      });
    };
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HealthTimeoutError()), timeoutMs);
    });

    const tqInfo = await Promise.race([describe(), timeoutPromise]);
    const latencyMs = Date.now() - start;

    const pollers = tqInfo.pollers ?? [];
    const pollersCount = pollers.length;
    const workerPollingStatus = pollersCount > 0 ? ('ok' as const) : ('down' as const);

    return {
      status: 'ok',
      latencyMs,
      workerPolling: {
        status: workerPollingStatus,
        pollersCount,
      },
    };
  } catch (err) {
    logger.warn({ err }, 'health: temporal check failed');
    return {
      status: 'down',
      latencyMs: Date.now() - start,
      error: publicError(err),
      workerPolling: {
        status: 'down',
        pollersCount: 0,
      },
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function createHealthRouter(deps: HealthCheckDependencies = {}): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const env = deps.env ?? getEnv();
      const redis = deps.redis ?? getRedis();
      const customFetch = deps.fetchFn ?? fetch;
      // Pass the factory (not a started promise) so connecting happens inside the 1s timeout.
      const temporalClient = deps.temporalClient ?? getTemporalClient;

      const [redisHealth, supplierAHealth, supplierBHealth, temporalHealth] =
        await Promise.all([
          checkRedisHealth(redis),
          checkSupplierHealth(`${env.SUPPLIER_A_URL}/hotels?city=__health`, customFetch),
          checkSupplierHealth(`${env.SUPPLIER_B_URL}/hotels?city=__health`, customFetch),
          checkTemporalHealth(env, temporalClient),
        ]);

      // Status determination policy:
      // - All healthy & worker polling: ok (200)
      // - Exactly one supplier down, everything else ok: degraded (200)
      // - Both suppliers down OR Redis down OR Temporal down OR no worker polling: down (503)
      const isRedisOk = redisHealth.status === 'ok';
      const isTemporalOk =
        temporalHealth.status === 'ok' && temporalHealth.workerPolling.status === 'ok';
      const isSupplierAOk = supplierAHealth.status === 'ok';
      const isSupplierBOk = supplierBHealth.status === 'ok';

      let overallStatus: 'ok' | 'degraded' | 'down';
      let httpStatus = 200;

      if (!isRedisOk || !isTemporalOk || (!isSupplierAOk && !isSupplierBOk)) {
        overallStatus = 'down';
        httpStatus = 503;
      } else if (!isSupplierAOk || !isSupplierBOk) {
        overallStatus = 'degraded';
        httpStatus = 200;
      } else {
        overallStatus = 'ok';
        httpStatus = 200;
      }

      const body: HealthResponse = {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        dependencies: {
          supplierA: supplierAHealth,
          supplierB: supplierBHealth,
          redis: redisHealth,
          temporal: temporalHealth,
        },
      };

      res.status(httpStatus).json(body);
    } catch (err) {
      // Invariant I10: /health never throws or leaks internals
      logger.error({ err }, 'unexpected error in /health check');
      res.status(503).json({
        status: 'down',
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        dependencies: {
          supplierA: { status: 'down', error: 'Internal health check error' },
          supplierB: { status: 'down', error: 'Internal health check error' },
          redis: { status: 'down', error: 'Internal health check error' },
          temporal: {
            status: 'down',
            error: 'Internal health check error',
            workerPolling: { status: 'down', pollersCount: 0 },
          },
        },
      });
    }
  });

  return router;
}

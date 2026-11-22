import Redis from 'ioredis';
import { getEnv } from '../config/env';
import { logger } from './logger';

let client: Redis | undefined;

export type RedisClient = Redis;

export function createRedis(url: string): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 3,
    // WHY: fail a request fast when Redis is unreachable so the API returns 503 CACHE_UNAVAILABLE
    // in ~seconds instead of hanging on the 10s default connect timeout.
    connectTimeout: 2000,
    // WHY: exponential cap at 2s so a dead Redis does not retry-storm (rejected: infinite immediate reconnect).
    retryStrategy(times) {
      return Math.min(times * 50, 2000);
    },
  });

  redis.on('error', (err) => {
    logger.error({ err }, 'redis connection error');
  });

  return redis;
}

export function getRedis(): Redis {
  if (!client) {
    client = createRedis(getEnv().REDIS_URL);
  }
  return client;
}

export async function pingRedis(redis: Redis = getRedis()): Promise<string> {
  return redis.ping();
}

export async function closeRedis(): Promise<void> {
  if (!client) {
    return;
  }
  const current = client;
  client = undefined;
  await current.quit();
}

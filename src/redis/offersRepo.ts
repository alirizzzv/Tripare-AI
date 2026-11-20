import type Redis from 'ioredis';
import { normalizeCity } from '../domain/normalize';
import { deserializeOffer, serializeOffer } from '../domain/serialize';
import type { Offer } from '../domain/types';

export type SaveOffersOptions = {
  degraded: boolean;
  failedSuppliers: string[];
  ttlSeconds: number;
};

export type ReadOffersOptions = {
  min?: number;
  max?: number;
};

export type ReadOffersResult = {
  hit: boolean;
  offers: Offer[];
  degraded: boolean;
  failedSuppliers: string[];
  fetchedAt: string | null;
};

export function offersKey(city: string): string {
  return `hotels:${normalizeCity(city)}:offers`;
}

export function metaKey(city: string): string {
  return `hotels:${normalizeCity(city)}:meta`;
}

export async function saveOffers(
  redis: Redis,
  city: string,
  offers: Offer[],
  options: SaveOffersOptions,
): Promise<void> {
  const oKey = offersKey(city);
  const mKey = metaKey(city);
  const fetchedAt = new Date().toISOString();

  // WHY: one MULTI so a reader never sees deleted offers without meta, or mixed generations (rejected: pipelined-but-not-atomic sequential awaits).
  const tx = redis.multi();
  tx.del(oKey, mKey);
  if (offers.length > 0) {
    const zaddArgs: (string | number)[] = [];
    for (const offer of offers) {
      zaddArgs.push(offer.price, serializeOffer(offer));
    }
    tx.zadd(oKey, ...zaddArgs);
  }
  tx.hset(mKey, {
    degraded: options.degraded ? 'true' : 'false',
    failedSuppliers: options.failedSuppliers.join(','),
    fetchedAt,
  });
  tx.expire(oKey, options.ttlSeconds);
  tx.expire(mKey, options.ttlSeconds);
  await tx.exec();
}

export async function readOffers(
  redis: Redis,
  city: string,
  options: ReadOffersOptions = {},
): Promise<ReadOffersResult> {
  const oKey = offersKey(city);
  const mKey = metaKey(city);
  const min = options.min === undefined ? '-inf' : options.min;
  const max = options.max === undefined ? '+inf' : options.max;

  // WHY: filter in Redis (ZRANGEBYSCORE inclusive) so Node never post-filters prices (I4).
  const tx = redis.multi();
  tx.hgetall(mKey);
  tx.zrangebyscore(oKey, min, max);
  const execResult = await tx.exec();
  if (!execResult) {
    throw new Error('redis MULTI/EXEC returned null (transaction aborted)');
  }

  const metaReply = execResult[0];
  const membersReply = execResult[1];
  if (!metaReply || !membersReply) {
    throw new Error('redis MULTI/EXEC missing replies');
  }
  if (metaReply[0]) {
    throw metaReply[0];
  }
  if (membersReply[0]) {
    throw membersReply[0];
  }

  const meta = (metaReply[1] ?? {}) as Record<string, string>;
  const members = (membersReply[1] ?? []) as string[];
  const hit = Object.keys(meta).length > 0;
  if (!hit) {
    return {
      hit: false,
      offers: [],
      degraded: false,
      failedSuppliers: [],
      fetchedAt: null,
    };
  }

  const failedRaw = meta['failedSuppliers'] ?? '';
  return {
    hit: true,
    offers: members.map((member) => deserializeOffer(member)),
    degraded: meta['degraded'] === 'true',
    failedSuppliers: failedRaw === '' ? [] : failedRaw.split(','),
    fetchedAt: meta['fetchedAt'] ?? null,
  };
}

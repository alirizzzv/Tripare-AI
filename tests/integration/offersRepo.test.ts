/**
 * Requires a real Redis. From the repo root:
 *   docker compose up -d redis
 * Tests use Redis DB 1 (override with TEST_REDIS_URL) so they never touch app cache in DB 0.
 */
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Offer } from '../../src/domain/types';
import { metaKey, offersKey, readOffers, saveOffers } from '../../src/redis/offersRepo';

const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';
const redis = new Redis(redisUrl);

const cities: string[] = [];

function uniqueCity(): string {
  const city = `itest ${randomUUID()}`;
  cities.push(city);
  return city;
}

function offer(partial: Partial<Offer> & Pick<Offer, 'name' | 'price'>): Offer {
  return {
    supplier: 'Supplier A',
    commissionPct: 10,
    ...partial,
  };
}

afterEach(async () => {
  if (cities.length === 0) {
    return;
  }
  const keys = cities.flatMap((c) => [offersKey(c), metaKey(c)]);
  cities.length = 0;
  if (keys.length > 0) {
    await redis.del(...keys);
  }
});

afterAll(async () => {
  await redis.quit();
});

describe('offersRepo', () => {
  it('saves and reads all offers', async () => {
    const city = uniqueCity();
    const offers = [
      offer({ name: 'Cheap', price: 100, supplier: 'Supplier B', commissionPct: 20 }),
      offer({ name: 'Dear', price: 500 }),
    ];
    await saveOffers(redis, city, offers, {
      degraded: false,
      failedSuppliers: [],
      ttlSeconds: 60,
    });
    const result = await readOffers(redis, city);
    expect(result.hit).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.failedSuppliers).toEqual([]);
    expect(result.fetchedAt).toMatch(/^\d{4}-/);
    expect(result.offers.map((o) => o.name)).toEqual(['Cheap', 'Dear']);
  });

  it('applies inclusive min and max boundaries', async () => {
    const city = uniqueCity();
    await saveOffers(
      redis,
      city,
      [
        offer({ name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 }),
        offer({ name: 'Low', price: 1000 }),
        offer({ name: 'High', price: 9000 }),
      ],
      { degraded: false, failedSuppliers: [], ttlSeconds: 60 },
    );
    const both = await readOffers(redis, city, { min: 5340, max: 5340 });
    expect(both.offers.map((o) => o.name)).toEqual(['Holtin']);
  });

  it('filters with only-min and only-max', async () => {
    const city = uniqueCity();
    await saveOffers(
      redis,
      city,
      [
        offer({ name: 'A', price: 10 }),
        offer({ name: 'B', price: 50 }),
        offer({ name: 'C', price: 90 }),
      ],
      { degraded: false, failedSuppliers: [], ttlSeconds: 60 },
    );
    const minOnly = await readOffers(redis, city, { min: 50 });
    expect(minOnly.offers.map((o) => o.name)).toEqual(['B', 'C']);
    const maxOnly = await readOffers(redis, city, { max: 50 });
    expect(maxOnly.offers.map((o) => o.name)).toEqual(['A', 'B']);
  });

  it('empty offers saved => hit=true with []', async () => {
    const city = uniqueCity();
    await saveOffers(redis, city, [], {
      degraded: false,
      failedSuppliers: [],
      ttlSeconds: 60,
    });
    const result = await readOffers(redis, city);
    expect(result.hit).toBe(true);
    expect(result.offers).toEqual([]);
  });

  it('never saved => hit=false', async () => {
    const city = uniqueCity();
    const result = await readOffers(redis, city);
    expect(result.hit).toBe(false);
    expect(result.offers).toEqual([]);
  });

  it('sets TTL on both keys', async () => {
    const city = uniqueCity();
    await saveOffers(redis, city, [offer({ name: 'X', price: 1 })], {
      degraded: false,
      failedSuppliers: [],
      ttlSeconds: 90,
    });
    const offersTtl = await redis.ttl(offersKey(city));
    const metaTtl = await redis.ttl(metaKey(city));
    expect(offersTtl).toBeGreaterThan(0);
    expect(offersTtl).toBeLessThanOrEqual(90);
    expect(metaTtl).toBeGreaterThan(0);
    expect(metaTtl).toBeLessThanOrEqual(90);
  });

  it('re-saving replaces old data completely', async () => {
    const city = uniqueCity();
    await saveOffers(redis, city, [offer({ name: 'Old', price: 1 })], {
      degraded: true,
      failedSuppliers: ['supplierA'],
      ttlSeconds: 60,
    });
    await saveOffers(redis, city, [offer({ name: 'New', price: 2, supplier: 'Supplier B' })], {
      degraded: false,
      failedSuppliers: [],
      ttlSeconds: 60,
    });
    const result = await readOffers(redis, city);
    expect(result.offers.map((o) => o.name)).toEqual(['New']);
    expect(result.degraded).toBe(false);
    expect(result.failedSuppliers).toEqual([]);
  });

  it('degraded metadata round-trips', async () => {
    const city = uniqueCity();
    await saveOffers(redis, city, [offer({ name: 'X', price: 1 })], {
      degraded: true,
      failedSuppliers: ['supplierB'],
      ttlSeconds: 60,
    });
    const result = await readOffers(redis, city);
    expect(result.degraded).toBe(true);
    expect(result.failedSuppliers).toEqual(['supplierB']);
  });

  it('concurrent reads never see a half-written list', async () => {
    const city = uniqueCity();
    const genA = [offer({ name: 'Alpha', price: 10 }), offer({ name: 'Beta', price: 20 })];
    const genB = [offer({ name: 'Gamma', price: 30 })];
    const opts = { degraded: false, failedSuppliers: [] as string[], ttlSeconds: 60 };

    await saveOffers(redis, city, genA, opts);

    const seen = new Set<string>();
    const writers = Array.from({ length: 40 }, (_, i) =>
      saveOffers(redis, city, i % 2 === 0 ? genA : genB, opts),
    );
    const readers = Array.from({ length: 80 }, async () => {
      const result = await readOffers(redis, city);
      if (!result.hit) {
        seen.add('MISS');
        return;
      }
      seen.add(result.offers.map((o) => o.name).join(','));
    });

    await Promise.all([...writers, ...readers]);
    for (const snapshot of seen) {
      expect(['Alpha,Beta', 'Gamma', 'MISS']).toContain(snapshot);
    }
  });
});

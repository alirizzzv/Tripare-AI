import type Redis from 'ioredis';
import { ApplicationFailure } from '@temporalio/activity';
import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../src/config/env';
import type { Offer } from '../../src/domain/types';
import { createActivities } from '../../src/temporal/activities';

function testEnv() {
  return loadEnv({
    ...process.env,
    SUPPLIER_A_URL: 'http://supplier-a.local',
    SUPPLIER_B_URL: 'http://supplier-b.local',
    SUPPLIER_TIMEOUT_MS: '100',
    CACHE_TTL_SECONDS: '600',
    DEGRADED_TTL_SECONDS: '60',
  });
}

describe('fetchSupplierHotels activity', () => {
  it('parses valid supplier response, filters by city, and maps to Offer format', async () => {
    const mockData = [
      { hotelId: 'a1', name: 'Taj Palace', price: 5000, city: 'delhi', commissionPct: 15 },
      { hotelId: 'a2', name: 'Trident', price: 6000, city: 'mumbai', commissionPct: 10 },
    ];

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockData,
    } as unknown as Response);

    const activities = createActivities({
      config: testEnv(),
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const offers = await activities.fetchSupplierHotels({ supplier: 'supplierA', city: 'delhi' });

    expect(offers).toHaveLength(1);
    expect(offers[0]).toEqual({
      name: 'Taj Palace',
      price: 5000,
      supplier: 'Supplier A',
      commissionPct: 15,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/hotels?city=delhi'),
      expect.any(Object),
    );
  });

  it('skips invalid records and filters wrong-city records', async () => {
    const mixedData = [
      { hotelId: 'a1', name: 'Valid Delhi', price: 5000, city: 'delhi', commissionPct: 12 },
      { hotelId: '', name: 'Invalid Id', price: 5000, city: 'delhi', commissionPct: 12 },
      { hotelId: 'a2', name: 'Negative Price', price: -500, city: 'delhi', commissionPct: 12 },
      { hotelId: 'a3', name: 'Wrong City', price: 4000, city: 'jaipur', commissionPct: 12 },
    ];

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mixedData,
    } as unknown as Response);

    const activities = createActivities({
      config: testEnv(),
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const offers = await activities.fetchSupplierHotels({ supplier: 'supplierA', city: 'delhi' });

    expect(offers).toHaveLength(1);
    expect(offers[0]?.name).toBe('Valid Delhi');
  });

  it('throws non-retryable ApplicationFailure on HTTP 400', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
    } as unknown as Response);

    const activities = createActivities({
      config: testEnv(),
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(
      activities.fetchSupplierHotels({ supplier: 'supplierA', city: 'delhi' }),
    ).rejects.toThrow(ApplicationFailure);

    try {
      await activities.fetchSupplierHotels({ supplier: 'supplierA', city: 'delhi' });
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationFailure);
      expect((err as ApplicationFailure).nonRetryable).toBe(true);
      expect((err as ApplicationFailure).type).toBe('SupplierNonRetryableError');
    }
  });

  it('throws retryable ApplicationFailure on HTTP 408 and 429', async () => {
    for (const status of [408, 429]) {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status,
      } as unknown as Response);

      const activities = createActivities({
        config: testEnv(),
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      try {
        await activities.fetchSupplierHotels({ supplier: 'supplierA', city: 'delhi' });
      } catch (err) {
        expect(err).toBeInstanceOf(ApplicationFailure);
        expect((err as ApplicationFailure).nonRetryable).toBe(false);
      }
    }
  });

  it('throws retryable ApplicationFailure on HTTP 503', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    } as unknown as Response);

    const activities = createActivities({
      config: testEnv(),
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    try {
      await activities.fetchSupplierHotels({ supplier: 'supplierA', city: 'delhi' });
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationFailure);
      expect((err as ApplicationFailure).nonRetryable).toBe(false);
    }
  });

  it('throws non-retryable ApplicationFailure on non-array payload', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: 'not an array' }),
    } as unknown as Response);

    const activities = createActivities({
      config: testEnv(),
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    try {
      await activities.fetchSupplierHotels({ supplier: 'supplierA', city: 'delhi' });
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationFailure);
      expect((err as ApplicationFailure).nonRetryable).toBe(true);
      expect((err as ApplicationFailure).type).toBe('SupplierNonRetryableError');
    }
  });

  it('times out using AbortController and throws retryable error', async () => {
    const mockFetch = vi.fn().mockImplementation((_url, opts) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });
    });

    const env = testEnv();
    // 50ms timeout
    env.SUPPLIER_TIMEOUT_MS = 50;

    const activities = createActivities({
      config: env,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    try {
      await activities.fetchSupplierHotels({ supplier: 'supplierA', city: 'delhi' });
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationFailure);
      expect((err as ApplicationFailure).nonRetryable).toBe(false);
      expect((err as ApplicationFailure).message).toMatch(/timed out/i);
    }
  });
});

describe('persistOffers activity', () => {
  it('saves offers with CACHE_TTL_SECONDS for healthy results', async () => {
    const mockRedis = {
      multi: vi.fn().mockReturnValue({
        del: vi.fn().mockReturnThis(),
        zadd: vi.fn().mockReturnThis(),
        hset: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([null, null, null, null, null]),
      }),
    };

    const env = testEnv();
    const activities = createActivities({
      config: env,
      redis: mockRedis as unknown as Redis,
    });

    const testOffers: Offer[] = [
      { name: 'Hotel 1', price: 1000, supplier: 'Supplier A', commissionPct: 10 },
    ];

    await activities.persistOffers({
      city: 'delhi',
      offers: testOffers,
      degraded: false,
      failedSuppliers: [],
    });

    const tx = mockRedis.multi();
    expect(tx.expire).toHaveBeenCalledWith(expect.any(String), 600);
  });

  it('saves offers with DEGRADED_TTL_SECONDS for degraded results', async () => {
    const mockExpire = vi.fn().mockReturnThis();
    const mockMulti = {
      del: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      hset: vi.fn().mockReturnThis(),
      expire: mockExpire,
      exec: vi.fn().mockResolvedValue([null, null, null, null, null]),
    };
    const mockRedis = {
      multi: vi.fn().mockReturnValue(mockMulti),
    };

    const env = testEnv();
    const activities = createActivities({
      config: env,
      redis: mockRedis as unknown as Redis,
    });

    await activities.persistOffers({
      city: 'delhi',
      offers: [],
      degraded: true,
      failedSuppliers: ['supplierB'],
    });

    expect(mockExpire).toHaveBeenCalledWith(expect.any(String), 60);
  });
});

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app';
import { createHotelsRouter } from '../../src/api/routes/hotels';
import type { Offer } from '../../src/domain/types';
import { GatewayTimeoutError, ServiceUnavailableError } from '../../src/lib/errors';
import type { ReadOffersResult } from '../../src/redis/offersRepo';

const FOUR_KEYS = ['commissionPct', 'name', 'price', 'supplier'];

function makeOffer(partial: Partial<Offer> & Pick<Offer, 'name' | 'price' | 'supplier'>): Offer {
  return {
    commissionPct: 10,
    ...partial,
  };
}

describe('GET /api/hotels validation & error contract (Decision 14)', () => {
  const app = createApp({
    hotelsRouter: createHotelsRouter({
      readOffersFn: vi.fn().mockResolvedValue({
        hit: true,
        offers: [],
        degraded: false,
        failedSuppliers: [],
        fetchedAt: new Date().toISOString(),
      }),
    }),
  });

  it('400 on missing city', async () => {
    const res = await request(app).get('/api/hotels');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/city.*required/i);
  });

  it('400 on blank city', async () => {
    const res = await request(app).get('/api/hotels?city=');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('400 on invalid characters in city', async () => {
    const res = await request(app).get('/api/hotels?city=Delhi123!');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('400 on non-numeric minPrice', async () => {
    const res = await request(app).get('/api/hotels?city=delhi&minPrice=abc');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('400 on negative price', async () => {
    const res = await request(app).get('/api/hotels?city=delhi&minPrice=-10');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('400 on empty string bound', async () => {
    const res = await request(app).get('/api/hotels?city=delhi&minPrice=');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('400 when minPrice > maxPrice', async () => {
    const res = await request(app).get('/api/hotels?city=delhi&minPrice=6000&maxPrice=5000');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/exceed/i);
  });

  it('400 on repeated query parameters', async () => {
    const res = await request(app).get('/api/hotels?city=delhi&city=mumbai');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/repeated/i);
  });

  it('400 on array-notation query parameter', async () => {
    const res = await request(app).get('/api/hotels?city[]=delhi');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('400 on invalid refresh value', async () => {
    const res = await request(app).get('/api/hotels?city=delhi&refresh=yes');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/hotels cache-first flow & headers', () => {
  it('serves directly from cache on cache HIT with X-Cache: HIT', async () => {
    const cachedOffers: Offer[] = [
      makeOffer({ name: 'Taj', price: 5000, supplier: 'Supplier A' }),
    ];

    const mockWorkflow = vi.fn();
    const mockReadOffers = vi.fn().mockResolvedValue({
      hit: true,
      offers: cachedOffers,
      degraded: false,
      failedSuppliers: [],
      fetchedAt: new Date().toISOString(),
    } satisfies ReadOffersResult);

    const app = createApp({
      hotelsRouter: createHotelsRouter({
        runWorkflowFn: mockWorkflow,
        readOffersFn: mockReadOffers,
      }),
    });

    const res = await request(app).get('/api/hotels?city=delhi');
    expect(res.status).toBe(200);
    expect(res.header['x-cache']).toBe('HIT');
    expect(res.header['x-degraded']).toBeUndefined();
    expect(res.body).toEqual(cachedOffers);
    // Workflow was NOT called on cache HIT
    expect(mockWorkflow).not.toHaveBeenCalled();
  });

  it('serves degraded headers on cache HIT if metadata is degraded', async () => {
    const cachedOffers: Offer[] = [
      makeOffer({ name: 'Oberoi', price: 7000, supplier: 'Supplier B' }),
    ];

    const mockReadOffers = vi.fn().mockResolvedValue({
      hit: true,
      offers: cachedOffers,
      degraded: true,
      failedSuppliers: ['supplierA'],
      fetchedAt: new Date().toISOString(),
    } satisfies ReadOffersResult);

    const app = createApp({
      hotelsRouter: createHotelsRouter({
        readOffersFn: mockReadOffers,
      }),
    });

    const res = await request(app).get('/api/hotels?city=delhi');
    expect(res.status).toBe(200);
    expect(res.header['x-cache']).toBe('HIT');
    expect(res.header['x-degraded']).toBe('true');
    expect(res.header['x-failed-suppliers']).toBe('supplierA');
    expect(res.body).toEqual(cachedOffers);
  });

  it('runs workflow on cache MISS and returns X-Cache: MISS', async () => {
    const freshOffers: Offer[] = [
      makeOffer({ name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 }),
    ];

    const mockWorkflow = vi.fn().mockResolvedValue({
      status: 'OK',
      offers: freshOffers,
      degraded: false,
      failedSuppliers: [],
    });

    let calls = 0;
    const mockReadOffers = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        // Cold miss
        return {
          hit: false,
          offers: [],
          degraded: false,
          failedSuppliers: [],
          fetchedAt: null,
        } satisfies ReadOffersResult;
      }
      // Post-workflow fresh read
      return {
        hit: true,
        offers: freshOffers,
        degraded: false,
        failedSuppliers: [],
        fetchedAt: new Date().toISOString(),
      } satisfies ReadOffersResult;
    });

    const app = createApp({
      hotelsRouter: createHotelsRouter({
        runWorkflowFn: mockWorkflow,
        readOffersFn: mockReadOffers,
      }),
    });

    const res = await request(app).get('/api/hotels?city=delhi');
    expect(res.status).toBe(200);
    expect(res.header['x-cache']).toBe('MISS');
    expect(mockWorkflow).toHaveBeenCalledWith('delhi');
    expect(res.body).toEqual(freshOffers);
  });

  it('bypasses cache when refresh=true and returns X-Cache: REFRESH', async () => {
    const refreshedOffers: Offer[] = [
      makeOffer({ name: 'Refreshed Hotel', price: 4000, supplier: 'Supplier A' }),
    ];

    const mockWorkflow = vi.fn().mockResolvedValue({
      status: 'OK',
      offers: refreshedOffers,
      degraded: false,
      failedSuppliers: [],
    });

    const mockReadOffers = vi.fn().mockResolvedValue({
      hit: true,
      offers: refreshedOffers,
      degraded: false,
      failedSuppliers: [],
      fetchedAt: new Date().toISOString(),
    } satisfies ReadOffersResult);

    const app = createApp({
      hotelsRouter: createHotelsRouter({
        runWorkflowFn: mockWorkflow,
        readOffersFn: mockReadOffers,
      }),
    });

    const res = await request(app).get('/api/hotels?city=delhi&refresh=true');
    expect(res.status).toBe(200);
    expect(res.header['x-cache']).toBe('REFRESH');
    expect(mockWorkflow).toHaveBeenCalledWith('delhi');
    expect(res.body).toEqual(refreshedOffers);
  });

  it('returns 200 [] for valid city with no results (jaipur)', async () => {
    const mockReadOffers = vi.fn().mockResolvedValue({
      hit: true,
      offers: [],
      degraded: false,
      failedSuppliers: [],
      fetchedAt: new Date().toISOString(),
    } satisfies ReadOffersResult);

    const app = createApp({
      hotelsRouter: createHotelsRouter({
        readOffersFn: mockReadOffers,
      }),
    });

    const res = await request(app).get('/api/hotels?city=jaipur');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('GET /api/hotels error conditions & headers (Decision 14)', () => {
  it('returns 503 SUPPLIERS_UNAVAILABLE with Retry-After: 10 when both suppliers fail', async () => {
    const mockWorkflow = vi.fn().mockRejectedValue(
      new ServiceUnavailableError('SUPPLIERS_UNAVAILABLE', 'Both suppliers are currently unavailable'),
    );

    const mockReadOffers = vi.fn().mockResolvedValue({
      hit: false,
      offers: [],
      degraded: false,
      failedSuppliers: [],
      fetchedAt: null,
    } satisfies ReadOffersResult);

    const app = createApp({
      hotelsRouter: createHotelsRouter({
        runWorkflowFn: mockWorkflow,
        readOffersFn: mockReadOffers,
      }),
    });

    const res = await request(app).get('/api/hotels?city=delhi');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SUPPLIERS_UNAVAILABLE');
    expect(res.header['retry-after']).toBe('10');
  });

  it('returns 504 WORKFLOW_TIMEOUT when workflow wait expires', async () => {
    const mockWorkflow = vi.fn().mockRejectedValue(
      new GatewayTimeoutError('Workflow did not finish within 8000ms'),
    );

    const mockReadOffers = vi.fn().mockResolvedValue({
      hit: false,
      offers: [],
      degraded: false,
      failedSuppliers: [],
      fetchedAt: null,
    } satisfies ReadOffersResult);

    const app = createApp({
      hotelsRouter: createHotelsRouter({
        runWorkflowFn: mockWorkflow,
        readOffersFn: mockReadOffers,
      }),
    });

    const res = await request(app).get('/api/hotels?city=delhi');
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('WORKFLOW_TIMEOUT');
  });

  it('returns 503 CACHE_UNAVAILABLE when redis fails on read', async () => {
    const mockReadOffers = vi.fn().mockRejectedValue(new Error('Connection lost'));

    const app = createApp({
      hotelsRouter: createHotelsRouter({
        readOffersFn: mockReadOffers,
      }),
    });

    const res = await request(app).get('/api/hotels?city=delhi');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CACHE_UNAVAILABLE');
  });
});

describe('Invariant I1: Response format & exact 4 keys', () => {
  it('every response item has exactly four keys in a bare JSON array', async () => {
    const sampleOffers: Offer[] = [
      makeOffer({ name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 }),
      makeOffer({ name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 }),
    ];

    const mockReadOffers = vi.fn().mockResolvedValue({
      hit: true,
      offers: sampleOffers,
      degraded: false,
      failedSuppliers: [],
      fetchedAt: new Date().toISOString(),
    } satisfies ReadOffersResult);

    const app = createApp({
      hotelsRouter: createHotelsRouter({
        readOffersFn: mockReadOffers,
      }),
    });

    const res = await request(app).get('/api/hotels?city=delhi');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);

    for (const item of res.body) {
      expect(Object.keys(item).sort()).toEqual(FOUR_KEYS);
      expect(typeof item.name).toBe('string');
      expect(typeof item.price).toBe('number');
      expect(['Supplier A', 'Supplier B']).toContain(item.supplier);
      expect(typeof item.commissionPct).toBe('number');
    }
  });
});

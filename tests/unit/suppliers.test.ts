import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app';
import { loadEnv } from '../../src/config/env';
import { resetChaos } from '../../src/suppliers/chaos';

const hotelKeys = ['hotelId', 'name', 'price', 'city', 'commissionPct'];

function chaosEnv(overrides: Record<string, string | undefined> = {}) {
  return loadEnv({
    ...process.env,
    ENABLE_CHAOS: 'true',
    CHAOS_TOKEN: '',
    CHAOS_TTL_SECONDS: '60',
    ...overrides,
  });
}

afterEach(() => {
  resetChaos();
  vi.useRealTimers();
});

describe('mock suppliers', () => {
  const app = createApp();

  it('supplier A returns the hotel record shape', async () => {
    const res = await request(app).get('/supplierA/hotels');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const hotel of res.body) {
      expect(Object.keys(hotel).sort()).toEqual([...hotelKeys].sort());
    }
  });

  it('supplier B returns the hotel record shape', async () => {
    const res = await request(app).get('/supplierB/hotels');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const hotel of res.body) {
      expect(Object.keys(hotel).sort()).toEqual([...hotelKeys].sort());
    }
  });

  it('filters by city case-insensitively', async () => {
    const res = await request(app).get('/supplierA/hotels').query({ city: 'DeLhi' });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.every((h: { city: string }) => h.city === 'delhi')).toBe(true);
  });

  it('returns all cities when city is omitted', async () => {
    const res = await request(app).get('/supplierA/hotels');
    const cities = new Set(res.body.map((h: { city: string }) => h.city));
    expect(cities.has('delhi')).toBe(true);
    expect(cities.has('mumbai')).toBe(true);
  });

  it('returns [] for jaipur', async () => {
    const a = await request(app).get('/supplierA/hotels').query({ city: 'jaipur' });
    const b = await request(app).get('/supplierB/hotels').query({ city: 'jaipur' });
    expect(a.status).toBe(200);
    expect(a.body).toEqual([]);
    expect(b.status).toBe(200);
    expect(b.body).toEqual([]);
  });

  it('Holtin is 6000 on A and 5340 on B for delhi', async () => {
    const a = await request(app).get('/supplierA/hotels').query({ city: 'delhi' });
    const b = await request(app).get('/supplierB/hotels').query({ city: 'delhi' });
    const holtinA = a.body.find((h: { name: string }) => h.name === 'Holtin');
    const holtinB = b.body.find((h: { name: string }) => h.name.includes('HOLTIN'));
    expect(holtinA).toMatchObject({ price: 6000, commissionPct: 10 });
    expect(holtinB).toMatchObject({ price: 5340, commissionPct: 20 });
  });
});

describe('chaos controls', () => {
  it('chaos routes are absent when ENABLE_CHAOS=false', async () => {
    const app = createApp({ env: chaosEnv({ ENABLE_CHAOS: 'false' }) });
    const res = await request(app).get('/__chaos');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('GET /__chaos returns current modes', async () => {
    const app = createApp({ env: chaosEnv() });
    const res = await request(app).get('/__chaos');
    expect(res.status).toBe(200);
    expect(res.body.supplierA.mode).toBe('ok');
    expect(res.body.supplierB.mode).toBe('ok');
  });

  it('down mode returns 503 from the mock supplier', async () => {
    const app = createApp({ env: chaosEnv() });
    const set = await request(app)
      .post('/__chaos/supplierA')
      .send({ mode: 'down', delayMs: 0 });
    expect(set.status).toBe(200);
    const res = await request(app).get('/supplierA/hotels');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SUPPLIER_DOWN');
  });

  it('slow mode delays the supplier response', async () => {
    const app = createApp({ env: chaosEnv() });
    await request(app).post('/__chaos/supplierA').send({ mode: 'slow', delayMs: 40 });
    const started = Date.now();
    const res = await request(app).get('/supplierA/hotels');
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(35);
  });

  it('reset restores both suppliers to ok', async () => {
    const app = createApp({ env: chaosEnv() });
    await request(app).post('/__chaos/supplierA').send({ mode: 'down', delayMs: 0 });
    await request(app).post('/__chaos/supplierB').send({ mode: 'down', delayMs: 0 });
    const reset = await request(app).post('/__chaos/reset');
    expect(reset.status).toBe(200);
    expect(reset.body.supplierA.mode).toBe('ok');
    expect(reset.body.supplierB.mode).toBe('ok');
    const a = await request(app).get('/supplierA/hotels');
    expect(a.status).toBe(200);
  });

  it('non-ok mode auto-reverts after CHAOS_TTL_SECONDS', async () => {
    vi.useFakeTimers();
    const { getChaos, setChaos, setChaosTtlSeconds } = await import('../../src/suppliers/chaos');
    setChaosTtlSeconds(1);
    setChaos('supplierA', 'down', 0);
    expect(getChaos('supplierA').mode).toBe('down');
    await vi.advanceTimersByTimeAsync(1000);
    expect(getChaos('supplierA').mode).toBe('ok');
  });

  it('rejects missing chaos token with 401 when CHAOS_TOKEN is set', async () => {
    const app = createApp({ env: chaosEnv({ CHAOS_TOKEN: 'secret' }) });
    const res = await request(app).get('/__chaos');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects wrong chaos token with 401', async () => {
    const app = createApp({ env: chaosEnv({ CHAOS_TOKEN: 'secret' }) });
    const res = await request(app).get('/__chaos').set('x-chaos-token', 'nope');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('accepts a matching chaos token', async () => {
    const app = createApp({ env: chaosEnv({ CHAOS_TOKEN: 'secret' }) });
    const res = await request(app).get('/__chaos').set('x-chaos-token', 'secret');
    expect(res.status).toBe(200);
  });
});

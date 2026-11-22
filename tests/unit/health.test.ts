import type { Client } from '@temporalio/client';
import type Redis from 'ioredis';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app';
import { createHealthRouter } from '../../src/api/routes/health';
import { loadEnv } from '../../src/config/env';

function testEnv() {
  return loadEnv({
    ...process.env,
    SUPPLIER_A_URL: 'http://supplier-a.local',
    SUPPLIER_B_URL: 'http://supplier-b.local',
  });
}

function makeMockTemporalClient(isHealthy = true, pollersCount = 1) {
  if (!isHealthy) {
    return () => Promise.reject(new Error('Temporal connection failed')) as unknown as Promise<Client>;
  }
  return () =>
    Promise.resolve({
      workflowService: {
        describeTaskQueue: vi.fn().mockResolvedValue({
          pollers: Array.from({ length: pollersCount }, () => ({})),
        }),
      },
    }) as unknown as Promise<Client>;
}

describe('GET /health endpoint', () => {
  it('returns 200 "ok" when all components are healthy', async () => {
    const mockRedis = {
      ping: vi.fn().mockResolvedValue('PONG'),
    } as unknown as Redis;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as unknown as Response);

    const app = createApp({
      healthRouter: createHealthRouter({
        env: testEnv(),
        redis: mockRedis,
        fetchFn: mockFetch as unknown as typeof fetch,
        temporalClient: makeMockTemporalClient(true, 1),
      }),
    });

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.dependencies.redis.status).toBe('ok');
    expect(res.body.dependencies.supplierA.status).toBe('ok');
    expect(res.body.dependencies.supplierB.status).toBe('ok');
    expect(res.body.dependencies.temporal.status).toBe('ok');
    expect(res.body.dependencies.temporal.workerPolling.status).toBe('ok');
  });

  it('returns 200 "degraded" when exactly one supplier is down', async () => {
    const mockRedis = {
      ping: vi.fn().mockResolvedValue('PONG'),
    } as unknown as Redis;

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('supplier-a')) {
        return Promise.resolve({ ok: false, status: 503 });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });

    const app = createApp({
      healthRouter: createHealthRouter({
        env: testEnv(),
        redis: mockRedis,
        fetchFn: mockFetch as unknown as typeof fetch,
        temporalClient: makeMockTemporalClient(true, 1),
      }),
    });

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.dependencies.supplierA.status).toBe('down');
    expect(res.body.dependencies.supplierB.status).toBe('ok');
    expect(res.body.dependencies.redis.status).toBe('ok');
  });

  it('returns 503 "down" when both suppliers are down', async () => {
    const mockRedis = {
      ping: vi.fn().mockResolvedValue('PONG'),
    } as unknown as Redis;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });

    const app = createApp({
      healthRouter: createHealthRouter({
        env: testEnv(),
        redis: mockRedis,
        fetchFn: mockFetch as unknown as typeof fetch,
        temporalClient: makeMockTemporalClient(true, 1),
      }),
    });

    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('down');
    expect(res.body.dependencies.supplierA.status).toBe('down');
    expect(res.body.dependencies.supplierB.status).toBe('down');
  });

  it('returns 503 "down" when Redis is unreachable', async () => {
    const mockRedis = {
      ping: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 172.18.0.3:6379')),
    } as unknown as Redis;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    const app = createApp({
      healthRouter: createHealthRouter({
        env: testEnv(),
        redis: mockRedis,
        fetchFn: mockFetch as unknown as typeof fetch,
        temporalClient: makeMockTemporalClient(true, 1),
      }),
    });

    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('down');
    expect(res.body.dependencies.redis.status).toBe('down');
    // Regression (I13): raw error text with internal IPs must not reach the client.
    expect(res.body.dependencies.redis.error).toBe('unreachable');
    expect(JSON.stringify(res.body)).not.toContain('172.18.0.3');
  });

  it('returns 503 "down" when Temporal is unreachable', async () => {
    const mockRedis = {
      ping: vi.fn().mockResolvedValue('PONG'),
    } as unknown as Redis;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    const app = createApp({
      healthRouter: createHealthRouter({
        env: testEnv(),
        redis: mockRedis,
        fetchFn: mockFetch as unknown as typeof fetch,
        temporalClient: makeMockTemporalClient(false),
      }),
    });

    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('down');
    expect(res.body.dependencies.temporal.status).toBe('down');
    expect(res.body.dependencies.temporal.error).toBe('unreachable');
  });

  it('times out a hung Temporal connect within ~1s instead of hanging', async () => {
    const mockRedis = { ping: vi.fn().mockResolvedValue('PONG') } as unknown as Redis;
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const hangingClient = () => new Promise<Client>(() => {});

    const app = createApp({
      healthRouter: createHealthRouter({
        env: testEnv(),
        redis: mockRedis,
        fetchFn: mockFetch as unknown as typeof fetch,
        temporalClient: hangingClient,
      }),
    });

    const started = Date.now();
    const res = await request(app).get('/health');
    expect(Date.now() - started).toBeLessThan(2500);
    expect(res.status).toBe(503);
    expect(res.body.dependencies.temporal.error).toBe('timeout');
  });

  it('returns 503 "down" when no Temporal worker is polling the task queue', async () => {
    const mockRedis = {
      ping: vi.fn().mockResolvedValue('PONG'),
    } as unknown as Redis;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    const app = createApp({
      healthRouter: createHealthRouter({
        env: testEnv(),
        redis: mockRedis,
        fetchFn: mockFetch as unknown as typeof fetch,
        temporalClient: makeMockTemporalClient(true, 0), // 0 pollers!
      }),
    });

    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('down');
    expect(res.body.dependencies.temporal.workerPolling.status).toBe('down');
  });
});

import request from 'supertest';
import { createApp } from '../../src/api/app';

const app = createApp();

describe('GET /ping', () => {
  it('returns 200', async () => {
    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('GET /', () => {
  it('returns a JSON index of the endpoints instead of a 404', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.endpoints.hotels).toBe('/api/hotels?city=delhi');
    expect(res.body.endpoints.health).toBe('/health');
  });
});

describe('unknown route', () => {
  it('returns JSON 404 shape', async () => {
    const res = await request(app).get('/no-such-route');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
      },
    });
    expect(Object.keys(res.body.error).sort()).toEqual(['code', 'message']);
  });
});

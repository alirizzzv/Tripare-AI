import { Router, type NextFunction, type Request, type Response } from 'express';
import type Redis from 'ioredis';
import { z } from 'zod';
import { normalizeCity } from '../../domain/normalize';
import { ServiceUnavailableError, ValidationError } from '../../lib/errors';
import { getRedis } from '../../lib/redis';
import { runHotelWorkflow } from '../../lib/temporalClient';
import { readOffers, type ReadOffersResult } from '../../redis/offersRepo';

// ---------------------------------------------------------------------------
// Query validation schemas
// ---------------------------------------------------------------------------

/**
 * City: 1-60 characters, letters (any script), whitespace, dots, hyphens.
 * Normalization is performed via normalizeCity (Decision I8).
 */
const citySchema = z
  .string()
  .trim()
  .min(1, 'city cannot be empty')
  .max(60, 'city must be at most 60 characters')
  .regex(/^[\p{L}\s.-]+$/u, 'city contains invalid characters');

const priceSchema = z.string().transform((val, ctx) => {
  if (val.trim() === '') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'price cannot be empty string',
    });
    return z.NEVER;
  }
  const num = Number(val);
  if (!Number.isFinite(num) || Number.isNaN(num) || num < 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'price must be a finite non-negative number',
    });
    return z.NEVER;
  }
  return num;
});

const refreshSchema = z.enum(['true', 'false']).optional();

/**
 * Rejects repeated/array query parameters (e.g. city[]=a, city=a&city=b).
 */
function rejectRepeatedParams(query: Request['query'], checkedKeys: readonly string[]): void {
  for (const key of checkedKeys) {
    const raw = query[key];
    if (Array.isArray(raw)) {
      throw new ValidationError(`Repeated or array query parameter: ${key}`);
    }
  }
  for (const key of Object.keys(query)) {
    if (/\[/.test(key)) {
      throw new ValidationError(`Array or bracket notation query parameter: ${key}`);
    }
  }
}

/** Client-facing 400 details: which field failed and why (no internal Zod structure). */
function fieldIssues(
  field: string,
  issues: readonly { message: string }[],
): { field: string; message: string }[] {
  return issues.map((issue) => ({ field, message: issue.message }));
}

function setDegradedHeaders(
  res: Response,
  degraded: boolean,
  failedSuppliers: readonly string[],
): void {
  if (degraded) {
    res.setHeader('X-Degraded', 'true');
    res.setHeader('X-Failed-Suppliers', failedSuppliers.join(','));
  }
}

export type HotelsRouterDependencies = {
  redis?: Redis;
  runWorkflowFn?: (city: string) => Promise<unknown>;
  readOffersFn?: (
    redis: Redis,
    city: string,
    options?: { min?: number; max?: number },
  ) => Promise<ReadOffersResult>;
};

export function createHotelsRouter(deps: HotelsRouterDependencies = {}): Router {
  const router = Router();
  const getRedisClient = () => deps.redis ?? getRedis();
  const executeWorkflow = deps.runWorkflowFn ?? runHotelWorkflow;
  const executeReadOffers = deps.readOffersFn ?? readOffers;

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 1. Reject repeated / array parameters (Decision 14)
      rejectRepeatedParams(req.query, ['city', 'minPrice', 'maxPrice', 'refresh'] as const);

      // 2. Validate city parameter
      const rawCity = req.query.city;
      if (rawCity === undefined || rawCity === '') {
        throw new ValidationError('city query parameter is required');
      }
      if (typeof rawCity !== 'string') {
        throw new ValidationError('city must be a single string value');
      }
      const cityResult = citySchema.safeParse(rawCity);
      if (!cityResult.success) {
        throw new ValidationError(
          cityResult.error.issues.map((i) => i.message).join('; '),
          fieldIssues('city', cityResult.error.issues),
        );
      }

      // 3. Validate price filters
      let minPrice: number | undefined;
      let maxPrice: number | undefined;

      const rawMin = req.query.minPrice;
      if (rawMin !== undefined) {
        if (typeof rawMin !== 'string') {
          throw new ValidationError('minPrice must be a single value');
        }
        const minParsed = priceSchema.safeParse(rawMin);
        if (!minParsed.success) {
          throw new ValidationError(
            minParsed.error.issues.map((i) => i.message).join('; '),
            fieldIssues('minPrice', minParsed.error.issues),
          );
        }
        minPrice = minParsed.data;
      }

      const rawMax = req.query.maxPrice;
      if (rawMax !== undefined) {
        if (typeof rawMax !== 'string') {
          throw new ValidationError('maxPrice must be a single value');
        }
        const maxParsed = priceSchema.safeParse(rawMax);
        if (!maxParsed.success) {
          throw new ValidationError(
            maxParsed.error.issues.map((i) => i.message).join('; '),
            fieldIssues('maxPrice', maxParsed.error.issues),
          );
        }
        maxPrice = maxParsed.data;
      }

      if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
        throw new ValidationError('minPrice must not exceed maxPrice', [
          { field: 'minPrice', message: 'must be less than or equal to maxPrice' },
        ]);
      }

      // 4. Validate refresh flag
      const rawRefresh = req.query.refresh;
      if (rawRefresh !== undefined) {
        if (typeof rawRefresh !== 'string') {
          throw new ValidationError('refresh must be a single string');
        }
        const refreshParsed = refreshSchema.safeParse(rawRefresh);
        if (!refreshParsed.success) {
          throw new ValidationError('refresh must be "true" or "false"');
        }
      }
      const isRefresh = rawRefresh === 'true';

      // 5. Invariant I8: Normalize city everywhere with the same pure function
      const normalizedCity = normalizeCity(cityResult.data);
      const redis = getRedisClient();

      // 6. Cache-first check (Decision 3, 7)
      if (!isRefresh) {
        let cached: ReadOffersResult;
        try {
          cached = await executeReadOffers(redis, normalizedCity, {
            min: minPrice,
            max: maxPrice,
          });
        } catch (err) {
          req.log.error({ err, city: normalizedCity }, 'redis cache read failed');
          throw new ServiceUnavailableError('CACHE_UNAVAILABLE', 'Cache is unavailable');
        }

        if (cached.hit) {
          res.setHeader('X-Cache', 'HIT');
          setDegradedHeaders(res, cached.degraded, cached.failedSuppliers);
          res.status(200).json(cached.offers);
          return;
        }
      }

      // 7. Cache miss or refresh: trigger Temporal orchestrator workflow
      await executeWorkflow(normalizedCity);

      // 8. Re-read from Redis through the single read path (I4: Redis price filtering)
      let freshResult: ReadOffersResult;
      try {
        freshResult = await executeReadOffers(redis, normalizedCity, {
          min: minPrice,
          max: maxPrice,
        });
      } catch (err) {
        req.log.error({ err, city: normalizedCity }, 'redis cache re-read failed');
        throw new ServiceUnavailableError('CACHE_UNAVAILABLE', 'Cache is unavailable');
      }

      if (!freshResult.hit) {
        throw new ServiceUnavailableError(
          'CACHE_UNAVAILABLE',
          'Cache unexpectedly empty after successful workflow',
        );
      }

      res.setHeader('X-Cache', isRefresh ? 'REFRESH' : 'MISS');
      setDegradedHeaders(res, freshResult.degraded, freshResult.failedSuppliers);
      res.status(200).json(freshResult.offers);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

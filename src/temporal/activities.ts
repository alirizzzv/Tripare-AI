import { ApplicationFailure } from '@temporalio/activity';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { getEnv, type Env } from '../config/env';
import { cleanDisplayName, normalizeCity } from '../domain/normalize';
import { parseSupplierResponse } from '../domain/schemas';
import type { Offer, SupplierId, SupplierLabel } from '../domain/types';
import { logger as defaultLogger } from '../lib/logger';
import { getRedis } from '../lib/redis';
import { saveOffers } from '../redis/offersRepo';

export type FetchSupplierHotelsArgs = {
  supplier: SupplierId;
  city: string;
};

export type PersistOffersArgs = {
  city: string;
  offers: Offer[];
  degraded: boolean;
  failedSuppliers: string[];
};

export type ActivityDependencies = {
  config?: Env;
  redis?: Redis;
  logger?: Logger;
  fetchFn?: typeof fetch;
};

export function createActivities(deps: ActivityDependencies = {}) {
  const config = deps.config ?? getEnv();
  const redis = deps.redis ?? getRedis();
  const logger = deps.logger ?? defaultLogger;
  const customFetch = deps.fetchFn ?? fetch;

  return {
    async fetchSupplierHotels({ supplier, city }: FetchSupplierHotelsArgs): Promise<Offer[]> {
      const baseUrl = supplier === 'supplierA' ? config.SUPPLIER_A_URL : config.SUPPLIER_B_URL;
      const url = `${baseUrl}/hotels?city=${encodeURIComponent(city)}`;
      const supplierLabel: SupplierLabel = supplier === 'supplierA' ? 'Supplier A' : 'Supplier B';

      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => {
        controller.abort();
      }, config.SUPPLIER_TIMEOUT_MS);

      const startTime = Date.now();
      try {
        const response = await customFetch(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        clearTimeout(timeoutTimer);
        const durationMs = Date.now() - startTime;

        if (!response.ok) {
          const status = response.status;
          // WHY: 4xx (except 408 Request Timeout and 429 Too Many Requests) are non-retryable bugs/bad requests.
          if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
            throw ApplicationFailure.nonRetryable(
              `Supplier ${supplier} failed with client error HTTP ${status}`,
              'SupplierNonRetryableError',
            );
          }
          // 408, 429, and 5xx are retryable
          throw ApplicationFailure.retryable(
            `Supplier ${supplier} failed with retryable HTTP ${status}`,
            'SupplierRetryableError',
          );
        }

        let rawData: unknown;
        try {
          rawData = await response.json();
        } catch {
          throw ApplicationFailure.nonRetryable(
            `Supplier ${supplier} returned invalid JSON payload`,
            'SupplierNonRetryableError',
          );
        }

        // Schema validation & error handling
        let parsedResult: ReturnType<typeof parseSupplierResponse>;
        try {
          parsedResult = parseSupplierResponse(rawData);
        } catch {
          // Throws when rawData is not an array
          throw ApplicationFailure.nonRetryable(
            `Supplier ${supplier} payload is not an array`,
            'SupplierNonRetryableError',
          );
        }

        // Defensively filter by normalized city
        const normalizedTarget = normalizeCity(city);
        const matchingHotels = parsedResult.valid.filter(
          (h) => normalizeCity(h.city) === normalizedTarget,
        );

        // WHY: clean the display name at the supplier boundary so the API never returns " HOLTIN ".
        const offers: Offer[] = matchingHotels.map((h) => ({
          name: cleanDisplayName(h.name),
          price: h.price,
          supplier: supplierLabel,
          commissionPct: h.commissionPct,
        }));

        logger.info(
          {
            supplier,
            city,
            status: response.status,
            durationMs,
            invalidCount: parsedResult.invalidCount,
            returnedCount: offers.length,
          },
          'fetched supplier hotel offers',
        );

        return offers;
      } catch (err) {
        clearTimeout(timeoutTimer);
        if (err instanceof ApplicationFailure) {
          throw err;
        }

        const isAbort =
          err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
        const durationMs = Date.now() - startTime;

        logger.warn(
          {
            supplier,
            city,
            durationMs,
            isAbort,
            err: err instanceof Error ? err.message : String(err),
          },
          'supplier fetch failed with error',
        );

        if (isAbort) {
          throw ApplicationFailure.retryable(
            `Supplier ${supplier} request timed out after ${config.SUPPLIER_TIMEOUT_MS}ms`,
            'SupplierRetryableError',
          );
        }

        throw ApplicationFailure.retryable(
          `Supplier ${supplier} network error: ${err instanceof Error ? err.message : String(err)}`,
          'SupplierRetryableError',
        );
      }
    },

    async persistOffers({
      city,
      offers,
      degraded,
      failedSuppliers,
    }: PersistOffersArgs): Promise<void> {
      const ttl = degraded ? config.DEGRADED_TTL_SECONDS : config.CACHE_TTL_SECONDS;
      await saveOffers(redis, city, offers, {
        degraded,
        failedSuppliers,
        ttlSeconds: ttl,
      });

      logger.info(
        {
          city,
          count: offers.length,
          degraded,
          failedSuppliers,
          ttlSeconds: ttl,
        },
        'persisted offers to redis cache',
      );
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;

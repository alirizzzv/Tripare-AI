import { proxyActivities } from '@temporalio/workflow';
import { mergeBestOffers } from '../domain/merge';
import type { Offer, SupplierId } from '../domain/types';
import type { Activities } from './activities';

/**
 * DETERMINISM & ARCHITECTURAL BOUNDARY:
 *
 * Temporal workflows must be 100% deterministic to guarantee safe replay from event history.
 * Rules strictly followed here:
 * 1. ZERO non-deterministic primitives (no Date.now(), no Math.random(), no process.env).
 * 2. ZERO network, filesystem, or database I/O inside workflow code; all I/O is delegated to Activities.
 * 3. Only pure domain transformations (mergeBestOffers) and types are imported from src/domain.
 * 4. Parallel fan-out uses Promise.allSettled so an individual supplier failure does not crash
 *    the entire workflow, allowing the orchestrator to produce a graceful degraded response.
 */

export type HotelWorkflowInput = {
  city: string;
};

export type HotelWorkflowResult = {
  status: 'OK' | 'DEGRADED' | 'ALL_FAILED';
  offers: Offer[];
  degraded: boolean;
  failedSuppliers: SupplierId[];
};

const { fetchSupplierHotels, persistOffers } = proxyActivities<Activities>({
  startToCloseTimeout: '3s',
  scheduleToCloseTimeout: '6s',
  retry: {
    maximumAttempts: 3,
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '1s',
    nonRetryableErrorTypes: ['SupplierNonRetryableError'],
  },
});

export async function hotelOffersWorkflow(input: HotelWorkflowInput): Promise<HotelWorkflowResult> {
  const [resultA, resultB] = await Promise.allSettled([
    fetchSupplierHotels({ supplier: 'supplierA', city: input.city }),
    fetchSupplierHotels({ supplier: 'supplierB', city: input.city }),
  ]);

  const aFailed = resultA.status === 'rejected';
  const bFailed = resultB.status === 'rejected';

  // Invariant I2: Both suppliers down never writes cache and returns ALL_FAILED
  if (aFailed && bFailed) {
    return {
      status: 'ALL_FAILED',
      offers: [],
      degraded: true,
      failedSuppliers: ['supplierA', 'supplierB'],
    };
  }

  const offersA: Offer[] = resultA.status === 'fulfilled' ? resultA.value : [];
  const offersB: Offer[] = resultB.status === 'fulfilled' ? resultB.value : [];

  const failedSuppliers: SupplierId[] = [];
  if (aFailed) {
    failedSuppliers.push('supplierA');
  }
  if (bFailed) {
    failedSuppliers.push('supplierB');
  }

  const degraded = failedSuppliers.length > 0;
  const merged = mergeBestOffers(offersA, offersB);

  // Persist deduplicated offers to Redis atomically in an activity (I3, I7)
  await persistOffers({
    city: input.city,
    offers: merged,
    degraded,
    failedSuppliers,
  });

  return {
    status: degraded ? 'DEGRADED' : 'OK',
    offers: merged,
    degraded,
    failedSuppliers,
  };
}

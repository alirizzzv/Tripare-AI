import path from 'node:path';
import { ApplicationFailure } from '@temporalio/activity';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker, type WorkflowBundle } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Offer } from '../../src/domain/types';
import type { Activities } from '../../src/temporal/activities';
import { hotelOffersWorkflow } from '../../src/temporal/workflows';

const workflowsPath = path.resolve(__dirname, '../../src/temporal/workflows.ts');

describe('hotelOffersWorkflow integration with mocked activities', () => {
  let testEnv: TestWorkflowEnvironment;
  let workflowBundle: WorkflowBundle;

  beforeAll(async () => {
    // Note: TestWorkflowEnvironment.createLocal() runs a real local dev server binary.
    testEnv = await TestWorkflowEnvironment.createLocal();
    workflowBundle = await bundleWorkflowCode({ workflowsPath });
  }, 30_000);

  afterAll(async () => {
    await testEnv?.teardown();
  });

  it('both ok: merges offers, calls persistOffers with degraded=false', async () => {
    const persistOffersMock = vi.fn().mockResolvedValue(undefined);

    const mockActivities: Partial<Activities> = {
      fetchSupplierHotels: vi.fn().mockImplementation(async ({ supplier }) => {
        if (supplier === 'supplierA') {
          return [
            { name: 'Hotel A', price: 6000, supplier: 'Supplier A', commissionPct: 10 },
            { name: 'Overlap Hotel', price: 5000, supplier: 'Supplier A', commissionPct: 10 },
          ] satisfies Offer[];
        }
        return [
          { name: 'Hotel B', price: 4000, supplier: 'Supplier B', commissionPct: 15 },
          { name: 'Overlap Hotel', price: 4500, supplier: 'Supplier B', commissionPct: 15 },
        ] satisfies Offer[];
      }),
      persistOffers: persistOffersMock,
    };

    const taskQueue = 'test-both-ok';
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: mockActivities as Activities,
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(hotelOffersWorkflow, {
        taskQueue,
        workflowId: 'test-both-ok-wf',
        args: [{ city: 'delhi' }],
      });

      const result = await handle.result();
      expect(result.status).toBe('OK');
      expect(result.degraded).toBe(false);
      expect(result.failedSuppliers).toEqual([]);
      expect(result.offers).toHaveLength(3);

      // Overlap Hotel: Supplier B (4500) won over Supplier A (5000)
      const overlap = result.offers.find((o) => o.name === 'Overlap Hotel');
      expect(overlap?.price).toBe(4500);
      expect(overlap?.supplier).toBe('Supplier B');

      expect(persistOffersMock).toHaveBeenCalledTimes(1);
      expect(persistOffersMock).toHaveBeenCalledWith(
        expect.objectContaining({
          city: 'delhi',
          degraded: false,
          failedSuppliers: [],
        }),
      );
    });
  });

  it('supplier A down: returns degraded with Supplier B offers', async () => {
    const persistOffersMock = vi.fn().mockResolvedValue(undefined);

    const mockActivities: Partial<Activities> = {
      fetchSupplierHotels: vi.fn().mockImplementation(async ({ supplier }) => {
        if (supplier === 'supplierA') {
          throw ApplicationFailure.retryable('Supplier A network error', 'SupplierRetryableError');
        }
        return [
          { name: 'Hotel B Only', price: 4000, supplier: 'Supplier B', commissionPct: 15 },
        ] satisfies Offer[];
      }),
      persistOffers: persistOffersMock,
    };

    const taskQueue = 'test-a-down';
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: mockActivities as Activities,
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(hotelOffersWorkflow, {
        taskQueue,
        workflowId: 'test-a-down-wf',
        args: [{ city: 'delhi' }],
      });

      const result = await handle.result();
      expect(result.status).toBe('DEGRADED');
      expect(result.degraded).toBe(true);
      expect(result.failedSuppliers).toEqual(['supplierA']);
      expect(result.offers).toHaveLength(1);
      expect(result.offers[0]?.name).toBe('Hotel B Only');

      expect(persistOffersMock).toHaveBeenCalledWith(
        expect.objectContaining({
          degraded: true,
          failedSuppliers: ['supplierA'],
        }),
      );
    });
  });

  it('supplier B down: returns degraded with Supplier A offers', async () => {
    const persistOffersMock = vi.fn().mockResolvedValue(undefined);

    const mockActivities: Partial<Activities> = {
      fetchSupplierHotels: vi.fn().mockImplementation(async ({ supplier }) => {
        if (supplier === 'supplierB') {
          throw ApplicationFailure.retryable('Supplier B 503', 'SupplierRetryableError');
        }
        return [
          { name: 'Hotel A Only', price: 7000, supplier: 'Supplier A', commissionPct: 10 },
        ] satisfies Offer[];
      }),
      persistOffers: persistOffersMock,
    };

    const taskQueue = 'test-b-down';
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: mockActivities as Activities,
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(hotelOffersWorkflow, {
        taskQueue,
        workflowId: 'test-b-down-wf',
        args: [{ city: 'delhi' }],
      });

      const result = await handle.result();
      expect(result.status).toBe('DEGRADED');
      expect(result.degraded).toBe(true);
      expect(result.failedSuppliers).toEqual(['supplierB']);
      expect(result.offers).toHaveLength(1);
      expect(result.offers[0]?.name).toBe('Hotel A Only');
    });
  });

  it('both suppliers down: returns ALL_FAILED and persistOffers is NEVER called', async () => {
    const persistOffersMock = vi.fn().mockResolvedValue(undefined);

    const mockActivities: Partial<Activities> = {
      fetchSupplierHotels: vi.fn().mockImplementation(async () => {
        throw ApplicationFailure.retryable('Supplier down', 'SupplierRetryableError');
      }),
      persistOffers: persistOffersMock,
    };

    const taskQueue = 'test-both-down';
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: mockActivities as Activities,
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(hotelOffersWorkflow, {
        taskQueue,
        workflowId: 'test-both-down-wf',
        args: [{ city: 'delhi' }],
      });

      const result = await handle.result();
      expect(result.status).toBe('ALL_FAILED');
      expect(result.offers).toEqual([]);
      expect(result.failedSuppliers).toEqual(['supplierA', 'supplierB']);

      // Invariant I2: Persist must NEVER be called when both fail
      expect(persistOffersMock).not.toHaveBeenCalled();
    });
  });

  it('retries when activity fails once then succeeds', async () => {
    let attemptA = 0;
    const mockActivities: Partial<Activities> = {
      fetchSupplierHotels: vi.fn().mockImplementation(async ({ supplier }) => {
        if (supplier === 'supplierA') {
          attemptA++;
          if (attemptA === 1) {
            throw ApplicationFailure.retryable('Flaky failure attempt 1', 'SupplierRetryableError');
          }
          return [
            { name: 'Hotel After Retry', price: 5000, supplier: 'Supplier A', commissionPct: 10 },
          ] satisfies Offer[];
        }
        return [] satisfies Offer[];
      }),
      persistOffers: vi.fn().mockResolvedValue(undefined),
    };

    const taskQueue = 'test-retry-success';
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: mockActivities as Activities,
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(hotelOffersWorkflow, {
        taskQueue,
        workflowId: 'test-retry-success-wf',
        args: [{ city: 'delhi' }],
      });

      const result = await handle.result();
      expect(result.status).toBe('OK');
      expect(attemptA).toBe(2);
      expect(result.offers[0]?.name).toBe('Hotel After Retry');
    });
  });

  it('does NOT retry when activity throws non-retryable 4xx error (attempt count = 1)', async () => {
    let attempts = 0;
    const mockActivities: Partial<Activities> = {
      fetchSupplierHotels: vi.fn().mockImplementation(async ({ supplier }) => {
        if (supplier === 'supplierA') {
          attempts++;
          throw ApplicationFailure.nonRetryable('Bad request 400', 'SupplierNonRetryableError');
        }
        return [
          { name: 'Good B', price: 4000, supplier: 'Supplier B', commissionPct: 10 },
        ] satisfies Offer[];
      }),
      persistOffers: vi.fn().mockResolvedValue(undefined),
    };

    const taskQueue = 'test-non-retryable';
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: mockActivities as Activities,
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(hotelOffersWorkflow, {
        taskQueue,
        workflowId: 'test-non-retryable-wf',
        args: [{ city: 'delhi' }],
      });

      const result = await handle.result();
      expect(result.status).toBe('DEGRADED');
      expect(result.failedSuppliers).toEqual(['supplierA']);
      // Non-retryable error must not be retried!
      expect(attempts).toBe(1);
    });
  });
});

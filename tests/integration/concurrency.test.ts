import path from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Offer } from '../../src/domain/types';
import type { Activities } from '../../src/temporal/activities';
import { hotelOffersWorkflow } from '../../src/temporal/workflows';

const workflowsPath = path.resolve(__dirname, '../../src/temporal/workflows.ts');

describe('Invariant I6: Concurrency test with real Temporal server & worker', () => {
  let testEnv: TestWorkflowEnvironment;
  let workflowBundle: ReturnType<typeof bundleWorkflowCode> extends Promise<infer T> ? T : never;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createLocal();
    workflowBundle = await bundleWorkflowCode({ workflowsPath });
  }, 30_000);

  afterAll(async () => {
    await testEnv?.teardown();
  });

  it(
    '20 concurrent cold requests for the same city share ONE workflow run and fetch activities execute exactly once each',
    async () => {
      let fetchCallsA = 0;
      let fetchCallsB = 0;

      const mockActivities: Partial<Activities> = {
        fetchSupplierHotels: vi.fn().mockImplementation(async ({ supplier }) => {
          // Delay ~500ms so all 20 concurrent workflow executions arrive while the first execution is in-flight
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (supplier === 'supplierA') {
            fetchCallsA++;
            return [
              { name: 'Taj Palace', price: 6000, supplier: 'Supplier A', commissionPct: 10 },
            ] satisfies Offer[];
          }
          fetchCallsB++;
          return [
            { name: 'Taj Palace', price: 5500, supplier: 'Supplier B', commissionPct: 15 },
          ] satisfies Offer[];
        }),
        persistOffers: vi.fn().mockResolvedValue(undefined),
      };

      const taskQueue = 'test-concurrency-tq';
      const worker = await Worker.create({
        connection: testEnv.nativeConnection,
        taskQueue,
        workflowBundle,
        activities: mockActivities as Activities,
      });

      await worker.runUntil(async () => {
        // Workflow ID matching deterministic pattern
        const workflowId = 'hotels-delhi-concurrency';

        // Fire 20 concurrent requests for the same city
        const concurrentCount = 20;
        const requests = Array.from({ length: concurrentCount }, async () => {
          // Starts with USE_EXISTING conflict policy
          const handle = await testEnv.client.workflow.start(hotelOffersWorkflow, {
            taskQueue,
            workflowId,
            workflowIdConflictPolicy: 'USE_EXISTING',
            args: [{ city: 'delhi' }],
          });
          return handle.result();
        });

        const results = await Promise.all(requests);

        // 1. All 20 results must be identical and correct
        expect(results).toHaveLength(concurrentCount);
        const firstResult = results[0];
        expect(firstResult?.status).toBe('OK');
        expect(firstResult?.offers).toHaveLength(1);
        expect(firstResult?.offers[0]?.price).toBe(5500); // Supplier B won
        expect(firstResult?.offers[0]?.supplier).toBe('Supplier B');

        for (const res of results) {
          expect(res).toEqual(firstResult);
        }

        // 2. Each fetch activity ran exactly once (2 calls total: 1 for A, 1 for B)
        expect(fetchCallsA).toBe(1);
        expect(fetchCallsB).toBe(1);
      });
    },
    25_000,
  );
});

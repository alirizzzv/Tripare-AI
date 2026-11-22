import { Connection, Client, WorkflowFailedError, WorkflowIdConflictPolicy } from '@temporalio/client';
import { getEnv } from '../config/env';
import { normalizeCity } from '../domain/normalize';
import { GatewayTimeoutError, ServiceUnavailableError } from './errors';
import { logger } from './logger';
import { buildWorkflowId } from '../temporal/constants';
import type { hotelOffersWorkflow, HotelWorkflowResult } from '../temporal/workflows';

let connection: Connection | undefined;
let client: Client | undefined;

export async function getTemporalConnection(): Promise<Connection> {
  if (!connection) {
    const env = getEnv();
    try {
      connection = await Connection.connect({
        address: env.TEMPORAL_ADDRESS,
      });
    } catch (err) {
      logger.error({ err, address: env.TEMPORAL_ADDRESS }, 'failed to connect to temporal server');
      // WHY: details stay in logs only; clients never see internal addresses or stack text (I13).
      throw new ServiceUnavailableError('ORCHESTRATOR_UNAVAILABLE', 'Temporal orchestrator unavailable');
    }
  }
  return connection;
}

export async function getTemporalClient(): Promise<Client> {
  if (!client) {
    const conn = await getTemporalConnection();
    const env = getEnv();
    client = new Client({
      connection: conn,
      namespace: env.TEMPORAL_NAMESPACE,
    });
  }
  return client;
}

export async function closeTemporalClient(): Promise<void> {
  if (connection) {
    const conn = connection;
    connection = undefined;
    client = undefined;
    await conn.close();
  }
}

export type RunHotelWorkflowOptions = {
  timeoutMs?: number;
};

/**
 * Runs or re-attaches to the deterministic workflow run for a normalized city (Invariants I6, I8).
 *
 * Concurrency: uses workflowIdConflictPolicy: USE_EXISTING so simultaneous cold requests
 * join the exact same in-flight execution rather than creating duplicate runs.
 */
export async function runHotelWorkflow(
  city: string,
  options: RunHotelWorkflowOptions = {},
): Promise<HotelWorkflowResult> {
  const env = getEnv();
  const normalizedCity = normalizeCity(city);
  const workflowId = buildWorkflowId(normalizedCity);
  const waitMs = options.timeoutMs ?? env.WORKFLOW_WAIT_MS;

  let temporalClient: Client;
  try {
    temporalClient = await getTemporalClient();
  } catch (err) {
    if (err instanceof ServiceUnavailableError) {
      throw err;
    }
    logger.error({ err }, 'failed to create temporal client');
    throw new ServiceUnavailableError('ORCHESTRATOR_UNAVAILABLE', 'Temporal orchestrator unavailable');
  }

  let handle;
  try {
    handle = await temporalClient.workflow.start<typeof hotelOffersWorkflow>(
      'hotelOffersWorkflow',
      {
        taskQueue: env.TEMPORAL_TASK_QUEUE,
        workflowId,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        workflowExecutionTimeout: '30s',
        args: [{ city: normalizedCity }],
      },
    );
  } catch (err) {
    logger.error({ err, workflowId, city: normalizedCity }, 'failed to start temporal workflow');
    throw new ServiceUnavailableError('ORCHESTRATOR_UNAVAILABLE', 'Temporal orchestrator unavailable');
  }

  let result: HotelWorkflowResult;
  try {
    // Race workflow result against waitMs (Decision 14, 504 on timeout without terminating)
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new GatewayTimeoutError(`Workflow did not finish within ${waitMs}ms`));
      }, waitMs);
    });

    try {
      result = await Promise.race([handle.result(), timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  } catch (err) {
    if (err instanceof GatewayTimeoutError) {
      logger.warn({ workflowId, waitMs }, 'workflow still running after wait budget; returning 504');
      throw err;
    }

    if (err instanceof WorkflowFailedError) {
      logger.error({ err, workflowId }, 'workflow execution failed');
      throw new ServiceUnavailableError('WORKFLOW_FAILED', 'Workflow execution failed');
    }

    logger.error({ err, workflowId }, 'unexpected error while awaiting workflow result');
    throw new ServiceUnavailableError('WORKFLOW_FAILED', 'Workflow execution failed');
  }

  // If both suppliers failed in the workflow (Invariant I2)
  if (result.status === 'ALL_FAILED') {
    logger.warn({ workflowId, city: normalizedCity }, 'both suppliers failed; nothing cached');
    throw new ServiceUnavailableError(
      'SUPPLIERS_UNAVAILABLE',
      'Both suppliers are currently unavailable',
    );
  }

  return result;
}

import { z } from 'zod';

const booleanFromEnv = z
  .enum(['true', 'false'])
  .optional()
  .default('false')
  .transform((v) => v === 'true');

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  TEMPORAL_ADDRESS: z.string().min(1).default('localhost:7233'),
  TEMPORAL_NAMESPACE: z.string().min(1).default('default'),
  TEMPORAL_TASK_QUEUE: z.string().min(1).default('hotel-offers'),
  SUPPLIER_A_URL: z.string().min(1).default('http://localhost:3000/supplierA'),
  SUPPLIER_B_URL: z.string().min(1).default('http://localhost:3000/supplierB'),
  SUPPLIER_TIMEOUT_MS: z.coerce.number().int().positive().default(2500),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  DEGRADED_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  WORKFLOW_WAIT_MS: z.coerce.number().int().positive().default(8000),
  ENABLE_CHAOS: booleanFromEnv,
  CHAOS_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v)),
  CHAOS_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  NODE_ENV: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment configuration: ${JSON.stringify(details)}`);
  }
  return parsed.data;
}

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) {
    cached = loadEnv();
  }
  return cached;
}

/** Test helper: drop the process-env cache so the next getEnv() re-parses. */
export function resetEnvCache(): void {
  cached = undefined;
}

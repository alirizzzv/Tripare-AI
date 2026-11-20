import { z } from 'zod';
import { normalizeName } from './normalize';
import type { SupplierRecord } from './types';

const supplierRecordSchema = z.object({
  hotelId: z.string().min(1),
  name: z.string().min(1),
  price: z.number().finite().gt(0),
  city: z.string().min(1),
  commissionPct: z.number().finite().gte(0).lte(100),
});

export type ParseSupplierResult = {
  valid: SupplierRecord[];
  invalidCount: number;
};

/**
 * Skip bad rows instead of failing the supplier. Throws only when the payload is not an array.
 * Workflow code must not import this file (Zod is non-deterministic-adjacent I/O-schema).
 */
export function parseSupplierResponse(raw: unknown): ParseSupplierResult {
  if (!Array.isArray(raw)) {
    throw new Error('Supplier payload is not an array');
  }

  const valid: SupplierRecord[] = [];
  let invalidCount = 0;

  for (const item of raw) {
    const parsed = supplierRecordSchema.safeParse(item);
    if (!parsed.success) {
      invalidCount += 1;
      continue;
    }
    if (normalizeName(parsed.data.name) === '') {
      invalidCount += 1;
      continue;
    }
    valid.push(parsed.data);
  }

  return { valid, invalidCount };
}

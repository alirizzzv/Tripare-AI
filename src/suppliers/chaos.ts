import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Env } from '../config/env';
import { UnauthorizedError, ValidationError } from '../lib/errors';
import type { SupplierKey } from './mockData';

export type ChaosMode = 'ok' | 'down' | 'slow';

type ChaosState = {
  mode: ChaosMode;
  delayMs: number;
  revertTimer: NodeJS.Timeout | null;
};

const supplierParamSchema = z.enum(['supplierA', 'supplierB']);

const chaosBodySchema = z.object({
  mode: z.enum(['ok', 'down', 'slow']),
  delayMs: z.number().int().min(0).max(10_000),
});

const states: Record<SupplierKey, ChaosState> = {
  supplierA: { mode: 'ok', delayMs: 0, revertTimer: null },
  supplierB: { mode: 'ok', delayMs: 0, revertTimer: null },
};

let chaosTtlSeconds = 60;

export function setChaosTtlSeconds(seconds: number): void {
  chaosTtlSeconds = seconds;
}

function clearRevert(supplier: SupplierKey): void {
  const timer = states[supplier].revertTimer;
  if (timer) {
    clearTimeout(timer);
    states[supplier].revertTimer = null;
  }
}

function snapshot(supplier: SupplierKey): { mode: ChaosMode; delayMs: number } {
  return { mode: states[supplier].mode, delayMs: states[supplier].delayMs };
}

export function resetChaos(): void {
  (['supplierA', 'supplierB'] as const).forEach((supplier) => {
    clearRevert(supplier);
    states[supplier] = { mode: 'ok', delayMs: 0, revertTimer: null };
  });
}

export function setChaos(supplier: SupplierKey, mode: ChaosMode, delayMs: number): void {
  clearRevert(supplier);
  states[supplier] = { mode, delayMs, revertTimer: null };
  if (mode !== 'ok') {
    // WHY: auto-revert so a live demo cannot leave a supplier permanently down (rejected: persist until reset).
    states[supplier].revertTimer = setTimeout(() => {
      states[supplier] = { mode: 'ok', delayMs: 0, revertTimer: null };
    }, chaosTtlSeconds * 1000);
    states[supplier].revertTimer.unref?.();
  }
}

export function getChaos(supplier: SupplierKey): { mode: ChaosMode; delayMs: number } {
  return snapshot(supplier);
}

export async function applyChaos(supplier: SupplierKey): Promise<'ok' | 'down'> {
  const current = states[supplier];
  if (current.mode === 'down') {
    return 'down';
  }
  if (current.mode === 'slow' && current.delayMs > 0) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, current.delayMs);
    });
  }
  return 'ok';
}

function requireChaosToken(env: Env) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!env.CHAOS_TOKEN) {
      next();
      return;
    }
    const header = req.header('x-chaos-token');
    if (header !== env.CHAOS_TOKEN) {
      next(new UnauthorizedError('Invalid or missing x-chaos-token'));
      return;
    }
    next();
  };
}

export function createChaosRouter(env: Env): Router {
  setChaosTtlSeconds(env.CHAOS_TTL_SECONDS);
  const router = Router();
  const auth = requireChaosToken(env);

  router.get('/__chaos', auth, (_req, res) => {
    res.json({
      supplierA: snapshot('supplierA'),
      supplierB: snapshot('supplierB'),
    });
  });

  router.post('/__chaos/reset', auth, (_req, res) => {
    resetChaos();
    res.json({
      supplierA: snapshot('supplierA'),
      supplierB: snapshot('supplierB'),
    });
  });

  router.post('/__chaos/:supplier', auth, (req, res, next) => {
    const supplierParsed = supplierParamSchema.safeParse(req.params.supplier);
    if (!supplierParsed.success) {
      next(new ValidationError('Invalid supplier', supplierParsed.error.flatten()));
      return;
    }
    const bodyParsed = chaosBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      next(new ValidationError('Invalid chaos body', bodyParsed.error.flatten()));
      return;
    }
    setChaos(supplierParsed.data, bodyParsed.data.mode, bodyParsed.data.delayMs);
    res.json({
      supplier: supplierParsed.data,
      ...snapshot(supplierParsed.data),
    });
  });

  return router;
}

import { randomUUID } from 'node:crypto';
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
  type Router,
} from 'express';
import pinoHttp from 'pino-http';
import type { Env } from '../config/env';
import { getEnv } from '../config/env';
import { AppError, NotFoundError, PayloadTooLargeError, ValidationError } from '../lib/errors';
import { logger } from '../lib/logger';
import { createChaosRouter } from '../suppliers/chaos';
import { createMockSupplierRouter } from '../suppliers/mockRouter';
import { createHealthRouter } from './routes/health';
import { createHotelsRouter } from './routes/hotels';

const JSON_BODY_LIMIT = '10kb';

export type CreateAppOptions = {
  env?: Env;
  hotelsRouter?: Router;
  healthRouter?: Router;
};

function requestIdFrom(req: Request): string {
  const incoming = req.headers['x-request-id'];
  if (typeof incoming === 'string' && incoming.trim() !== '') {
    return incoming;
  }
  return randomUUID();
}

function errorPayload(code: string, message: string, details?: unknown) {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

export function createApp(options: CreateAppOptions = {}): Express {
  const env = options.env ?? getEnv();
  const app = express();

  app.disable('x-powered-by');
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = requestIdFrom(req as Request);
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customProps: (req) => ({ requestId: req.id }),
    }),
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Liveness check for Docker / orchestration (AGENTS.md Decision 12)
  app.get('/ping', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  // Mock supplier APIs (INSIDE this same service)
  app.use('/supplierA', createMockSupplierRouter('supplierA'));
  app.use('/supplierB', createMockSupplierRouter('supplierB'));

  // Chaos controls (demo and resilience testing only)
  if (env.ENABLE_CHAOS) {
    app.use(createChaosRouter(env));
  }

  // Public business endpoints
  app.use('/api/hotels', options.hotelsRouter ?? createHotelsRouter());
  app.use('/health', options.healthRouter ?? createHealthRouter());

  // Unknown route handler (Decision 14: 404 NOT_FOUND)
  app.use((_req, _res, next) => {
    next(new NotFoundError());
  });

  // Central error handler (Decision 14)
  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (isPayloadTooLarge(err)) {
      const mapped = new PayloadTooLargeError();
      res.status(mapped.status).json(errorPayload(mapped.code, mapped.message));
      return;
    }

    if (isMalformedJson(err)) {
      const mapped = new ValidationError('Malformed JSON body');
      res.status(mapped.status).json(errorPayload(mapped.code, mapped.message));
      return;
    }

    const appErr = err instanceof AppError ? err : undefined;
    const status = appErr?.status ?? 500;
    const code = appErr?.code ?? 'INTERNAL_ERROR';
    const message = appErr?.message ?? 'Internal server error';
    const details = appErr?.details;

    // Decision 14: SUPPLIERS_UNAVAILABLE returns Retry-After: 10
    if (code === 'SUPPLIERS_UNAVAILABLE') {
      res.setHeader('Retry-After', '10');
    }

    if (status >= 500) {
      req.log.error({ err, requestId: req.id }, 'request failed');
    }

    res.status(status).json(errorPayload(code, message, details));
  };

  app.use(errorHandler);
  return app;
}

function isPayloadTooLarge(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    (err as { type?: string }).type === 'entity.too.large'
  );
}

function isMalformedJson(err: unknown): boolean {
  return err instanceof SyntaxError && 'body' in err;
}

import pino from 'pino';
import { getEnv } from '../config/env';

function buildLogger() {
  const env = getEnv();
  const pretty = env.NODE_ENV !== 'production';
  return pino({
    level: env.LOG_LEVEL,
    // WHY: pretty-print only off production so local logs are readable; JSON in prod for log shippers.
    transport: pretty
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined,
  });
}

export const logger = buildLogger();

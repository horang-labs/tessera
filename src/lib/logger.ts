import pino from 'pino';

// globalThis to survive Next.js hot reload (prevents WriteStream listener leak)
const _g = globalThis as unknown as Record<symbol, pino.Logger>;
const kLogger = Symbol.for('app.logger');

/**
 * Serialize an unknown error value into a JSON-friendly object.
 * Handles Error instances (non-enumerable props), plain strings, and objects.
 */
function serializeError(val: unknown): unknown {
  if (val instanceof Error) {
    return {
      type: val.constructor.name,
      message: val.message,
      stack: val.stack,
      ...((val as any).code ? { code: (val as any).code } : {}),
    };
  }
  return val;
}

if (!_g[kLogger]) {
  _g[kLogger] = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production' ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    } : undefined,
    base: {
      service: 'backend-pm',
    },
    serializers: {
      error: serializeError,
      reason: serializeError,
      err: pino.stdSerializers.err,
    },
    formatters: {
      level: (label) => {
        return { level: label.toUpperCase() };
      },
    },
  });
}

const logger = _g[kLogger];

export default logger;

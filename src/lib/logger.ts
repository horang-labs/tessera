import pino from 'pino';

// globalThis to survive Next.js hot reload (prevents WriteStream listener leak)
const _g = globalThis as unknown as Record<symbol, pino.Logger>;
const kLogger = Symbol.for('app.logger');
const isNodeTestRunner = Boolean(process.env.NODE_TEST_CONTEXT);
const defaultLogLevel =
  process.env.NODE_ENV === 'production' || process.env.TESSERA_CLI === '1'
    ? 'error'
    : 'info';

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
  const options: pino.LoggerOptions = {
    level: process.env.LOG_LEVEL || defaultLogLevel,
    transport: process.env.NODE_ENV !== 'production' && !isNodeTestRunner ? {
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
  };

  // pino-pretty runs through thread-stream. Node's test runner waits for that
  // worker's MessagePort, so a test file that merely imports server code never
  // exits after its assertions. Keep the same level/serializers in tests, but
  // write synchronously; normal development and production logging is unchanged.
  _g[kLogger] = isNodeTestRunner
    ? pino(options, pino.destination({ sync: true }))
    : pino(options);
}

const logger = _g[kLogger];

export default logger;

import { DEBUG_DIAGNOSTICS } from '@/lib/debug-diagnostics';

/**
 * Forwards the renderer's console into the main process so a debug build records it next to
 * the main and server logs.
 *
 * Electron's own `console-message` event only carries what Chromium already flattened to a
 * string — `console.error('failed:', err)` arrives as `failed: Error: boom`, with the stack
 * and every object argument lost. Serializing here, before the values leave the renderer, is
 * the only way to keep them. (`electron-log`'s `spyRendererConsole` uses that same event, so
 * it has the same blind spot.)
 *
 * Debug builds only: `DEBUG_DIAGNOSTICS` is a build-time literal, so a release folds every
 * reference to `false` and drops this whole path. The main process refuses the IPC channel
 * unless it is itself at debug level, so neither side can be switched on alone.
 */

type BridgeLevel = 'debug' | 'info' | 'warn' | 'error';

type ConsoleBridgeApi = {
  logRendererConsole?: (level: BridgeLevel, text: string) => void;
  notifyRendererConsoleBridgeReady?: () => void;
};

type ConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error';

const REMOTE_ERROR_ENDPOINT = '/api/diagnostics/client-error';
const MAX_REMOTE_ERROR_CHARS = 20_000;

const METHOD_LEVELS: Array<[ConsoleMethod, BridgeLevel]> = [
  ['debug', 'debug'],
  ['log', 'info'],
  ['info', 'info'],
  ['warn', 'warn'],
  ['error', 'error'],
];

// Generous on purpose: a debug build is expected to produce a large log, and a truncated
// payload is usually the one that mattered.
const MAX_CHARS_PER_ARGUMENT = 20_000;
const MAX_CHARS_PER_LINE = 120_000;

let installed = false;
// Guards against a report loop: if the send path itself logs, that log would be reported too.
let reporting = false;

function describeError(error: Error): string {
  const base = error.stack || `${error.name}: ${error.message}`;
  const cause = (error as { cause?: unknown }).cause;
  if (cause === undefined) return base;
  const causeText = cause instanceof Error ? cause.stack || cause.message : String(cause);
  return `${base}\n  caused by: ${causeText}`;
}

function describeObject(value: object): string {
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(
      value,
      (_key, raw: unknown) => {
        if (raw instanceof Error) {
          return { name: raw.name, message: raw.message, stack: raw.stack };
        }
        if (raw instanceof Map) {
          return { __type: `Map(${raw.size})`, entries: Array.from(raw.entries()) };
        }
        if (raw instanceof Set) {
          return { __type: `Set(${raw.size})`, values: Array.from(raw.values()) };
        }
        if (typeof raw === 'bigint') return `${raw}n`;
        if (typeof raw === 'function') {
          return `[Function ${(raw as { name?: string }).name || 'anonymous'}]`;
        }
        if (typeof raw === 'object' && raw !== null) {
          if (seen.has(raw)) return '[Circular]';
          seen.add(raw);
        }
        return raw;
      },
    );
    // `undefined` comes back for values JSON refuses outright (a bare function, a symbol).
    return json ?? String(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown';
    return `[Unserializable: ${reason}]`;
  }
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value !== 'object') return String(value);
  if (value instanceof Error) return describeError(value);

  // A DOM node serializes to `{}` and drags its whole parent chain into the walk.
  if (typeof Node !== 'undefined' && value instanceof Node) {
    const element = value as Partial<Element> & { nodeName?: string };
    const id = element.id ? `#${element.id}` : '';
    const cls = element.className && typeof element.className === 'string'
      ? `.${element.className.trim().split(/\s+/).join('.')}`
      : '';
    return `<${(element.nodeName || 'node').toLowerCase()}${id}${cls}>`;
  }

  return describeObject(value);
}

function clamp(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [${text.length - limit} more chars]`;
}

function formatArguments(args: unknown[]): string {
  const parts = args.map(arg => clamp(describe(arg), MAX_CHARS_PER_ARGUMENT));
  return clamp(parts.join(' '), MAX_CHARS_PER_LINE);
}

function getBridgeApi(): ConsoleBridgeApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { electronAPI?: ConsoleBridgeApi }).electronAPI;
}

/**
 * Wrap the console methods and mirror every call to the main process. The original method is
 * always called too, so DevTools and the terminal keep showing what they always showed.
 */
export function installRendererConsoleBridge(): void {
  if (!DEBUG_DIAGNOSTICS) return;
  if (installed) return;
  if (typeof window === 'undefined') return;

  const api = getBridgeApi();
  const electronSend = api?.logRendererConsole;

  // A phone renderer has no Electron preload, so its exception used to disappear at the
  // browser boundary. In a debug build only, mirror error-level reports back to the packaged
  // server. This gives the server log the actual Android stack instead of forcing a guess from
  // the generic Next global-error screen.
  const remoteSend = (level: BridgeLevel, text: string) => {
    if (level !== 'error') return;
    const payload = {
      level,
      text: clamp(text, MAX_REMOTE_ERROR_CHARS),
      url: window.location.href,
      userAgent: window.navigator.userAgent,
    };
    void window.fetch(REMOTE_ERROR_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => {
      // Diagnostics must never create a second application failure.
    });
  };

  const send = typeof electronSend === 'function' ? electronSend : remoteSend;

  installed = true;

  const report = (level: BridgeLevel, args: unknown[]) => {
    if (reporting) return;
    reporting = true;
    try {
      send(level, formatArguments(args));
    } catch {
      // Never let diagnostics break the app that produced them.
    } finally {
      reporting = false;
    }
  };

  for (const [method, level] of METHOD_LEVELS) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      report(level, args);
      original(...args);
    };
  }

  // Errors that never reach the console: a throw that escapes React, and a rejected promise
  // nobody caught. Both are exactly the failures worth having in a bug report.
  window.addEventListener('error', event => {
    const detail = event.error instanceof Error ? describeError(event.error) : event.message;
    const origin = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : '';
    report('error', [`[uncaught] ${detail}${origin}`]);
  });

  window.addEventListener('unhandledrejection', event => {
    report('error', ['[unhandled rejection]', event.reason]);
  });

  // Tells the main process to stop mirroring `console-message` for this window: from here on
  // the same lines arrive through this bridge, with their arguments intact.
  if (typeof electronSend === 'function') api?.notifyRendererConsoleBridgeReady?.();
}

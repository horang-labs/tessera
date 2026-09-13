import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

async function compile(entry, define = {}) {
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', define,
  });
  return result.outputFiles[0].text;
}

for (const enabled of [false, true]) {
  test(`browser PTY collection build flag ${enabled}`, async () => {
    const code = await compile('src/lib/terminal/terminal-latency-diagnostics.ts', {
      'process.env.NEXT_PUBLIC_TESSERA_PTY_LATENCY': JSON.stringify(enabled ? '1' : '0'),
    });
    const calls = { timers: 0, listeners: 0, frames: 0, fetches: 0 };
    let upload;
    const loaded = { exports: {} };
    const window = {
      setInterval(callback) { calls.timers++; upload = callback; return 1; },
      clearInterval() {},
    };
    vm.runInNewContext(code, {
      module: loaded, exports: loaded.exports, window,
      // Even a debug development runtime cannot enable an OFF build.
      process: { env: { NODE_ENV: 'development', NEXT_PUBLIC_TESSERA_LOG_LEVEL: 'debug', NEXT_PUBLIC_TESSERA_PTY_LATENCY: '1' } },
      document: { addEventListener() { calls.listeners++; } },
      performance: { now: () => 0 },
      requestAnimationFrame() { calls.frames++; },
      fetch: async () => { calls.fetches++; return { ok: true }; },
    });
    loaded.exports.traceTerminalLatency('xterm-input', 'surface', 3);
    upload?.();
    await Promise.resolve();
    assert.deepEqual(calls, enabled
      ? { timers: 1, listeners: 1, frames: 1, fetches: 1 }
      : { timers: 0, listeners: 0, frames: 0, fetches: 0 });
    assert.equal(Boolean(window.tesseraPtyLatency), enabled);
  });

  test(`server PTY collection flag ${enabled}`, async () => {
    const code = await compile('src/lib/terminal/terminal-server-latency.ts');
    let timers = 0;
    const timer = () => { timers++; return { unref() {} }; };
    const loaded = { exports: {} };
    vm.runInNewContext(code, {
      module: loaded, exports: loaded.exports, require,
      process: { env: { TESSERA_PTY_LATENCY: enabled ? '1' : '0', LOG_LEVEL: 'debug' } },
      setInterval: timer, setTimeout: timer,
    });
    loaded.exports.traceServerLatency('ws-input-received', 'terminal', 3);
    loaded.exports.startLatencySpan('git-panel-request')();
    assert.equal(timers, enabled ? 2 : 0);
  });
}

test('Next build flag defaults OFF, ignores public/debug flags, and invalidates cache when switched', () => {
  function config(flag) {
    const env = { ...process.env, NEXT_PUBLIC_TESSERA_LOG_LEVEL: 'debug', NEXT_PUBLIC_TESSERA_PTY_LATENCY: '1' };
    delete env.TESSERA_PTY_LATENCY;
    if (flag !== undefined) env.TESSERA_PTY_LATENCY = flag;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import config from './next.config.mjs';
      const webpack = config.webpack({ resolve: {}, cache: { version: 'test' } });
      console.log(JSON.stringify({ flag: config.env.NEXT_PUBLIC_TESSERA_PTY_LATENCY, cache: webpack.cache.version }));
    `], { env, encoding: 'utf8' }));
  }
  const off = config();
  assert.equal(off.flag, '0');
  assert.equal(config('true').flag, '0');
  assert.equal(config('0').flag, '0');
  const on = config('1');
  assert.equal(on.flag, '1');
  assert.notEqual(on.cache, off.cache);
  assert.deepEqual(config(), off);
});

test('packaged server opt-in comes from the same Next build, not inherited environment', () => {
  const prepare = readFileSync('scripts/prepare-electron-runtime.mjs', 'utf8');
  assert.match(prepare, /tesseraPtyLatency: nextBuild\.config\?\.env\?\.NEXT_PUBLIC_TESSERA_PTY_LATENCY === '1'/);
  const main = readFileSync('electron/main.ts', 'utf8');
  assert.match(main, /TESSERA_PTY_LATENCY: isPackaged\s*\? \(BUILD_METADATA\.tesseraPtyLatency === true \? '1' : '0'\)/);
});

test('diagnostics API is build-gated, authenticated, and persists only timing/counts', async () => {
  for (const enabled of [false, true]) {
    const result = await build({
      entryPoints: ['src/app/api/diagnostics/pty-latency/route.ts'],
      bundle: true, write: false, platform: 'node', format: 'cjs',
      define: { 'process.env.NEXT_PUBLIC_TESSERA_PTY_LATENCY': JSON.stringify(enabled ? '1' : '0') },
      plugins: [{ name: 'api-boundary-mocks', setup(builder) {
        builder.onResolve({ filter: /^(next\/server|@\/lib\/auth\/api-auth|@\/lib\/tessera-data-dir)$/ }, args => ({ path: args.path, external: true }));
      } }],
    });
    let authenticated = false;
    let authCalls = 0;
    const writes = [];
    const loaded = { exports: {} };
    vm.runInNewContext(result.outputFiles[0].text, {
      module: loaded, exports: loaded.exports, process: { pid: 42 },
      require(name) {
        if (name === 'next/server') return { NextResponse: Response };
        if (name === '@/lib/auth/api-auth') return { requireAuthenticatedUserId: async () => {
          authCalls++;
          return authenticated ? { userId: 'test' } : { response: new Response(null, { status: 401 }) };
        } };
        if (name === '@/lib/tessera-data-dir') return { getTesseraDataPath: () => '/mock-logs' };
        if (name === 'node:fs/promises') return { mkdir: async () => {}, writeFile: async (file, body) => writes.push({ file, body }) };
        return require(name);
      },
    });
    const request = (body) => ({ text: async () => JSON.stringify(body) });
    const sample = { at: 1, stage: 'xterm-input', length: 2, ms: 0, id: 'private-id', text: 'private-input' };
    const denied = await loaded.exports.POST(request([sample]));
    assert.equal(denied.status, enabled ? 401 : 404);
    assert.equal(authCalls, enabled ? 1 : 0);
    authenticated = true;
    const accepted = await loaded.exports.POST(request([sample]));
    assert.equal(accepted.status, enabled ? 204 : 404);
    assert.equal(writes.length, enabled ? 1 : 0);
    if (enabled) {
      const saved = JSON.parse(writes[0].body)[0];
      assert.deepEqual(Object.keys(saved).sort(), ['at', 'length', 'ms', 'receivedAt', 'stage']);
      assert.equal((await loaded.exports.POST(request([{ ...sample, stage: 'private-input' }]))).status, 400);
      assert.equal((await loaded.exports.POST(request(Array(501).fill(sample)))).status, 400);
    }
  }
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const entrypointPaths = {
  api: 'src/lib/auth/api-auth.ts',
  home: 'src/app/page.tsx',
  me: 'src/app/api/auth/me/route.ts',
  proxy: 'src/proxy.ts',
  websocket: 'src/lib/ws/server.ts',
};

test('all authentication entrypoints delegate credential decisions to request-gate', async () => {
  const entries = await Promise.all(
    Object.entries(entrypointPaths).map(async ([name, filePath]) => [
      name,
      await readFile(filePath, 'utf8'),
    ]),
  );
  const sources = Object.fromEntries(entries);

  for (const [name, source] of Object.entries(sources)) {
    assert.match(source, /auth\/request-gate|auth\/request-gate'|\.\.\/auth\/request-gate/, name);
    assert.doesNotMatch(source, /verifyToken|matchesAppSecret/, name);
  }

  assert.match(sources.api, /evaluateRequestAndLog\(input\)/);
  assert.match(sources.home, /evaluateRequestAndLog/);
  assert.match(sources.me, /evaluateRequestAndLog\(input\)/);
  assert.match(sources.websocket, /evaluateRequestAndLog\(input\)/);
  assert.match(sources.proxy, /hasPresentedCredential\(input\)/);
});

test('authentication entrypoints do not retain legacy Electron bypass or shadow branches', async () => {
  for (const filePath of Object.values(entrypointPaths)) {
    const source = await readFile(filePath, 'utf8');
    assert.doesNotMatch(source, /isElectronAuthBypassEnabled|observeRequestGate/, filePath);
  }
});

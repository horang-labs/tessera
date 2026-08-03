import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const entrypointPaths = {
  api: 'src/lib/auth/api-auth.ts',
  me: 'src/app/api/auth/me/route.ts',
  proxy: 'src/proxy.ts',
  websocket: 'src/lib/ws/server.ts',
};

test('all four authentication entrypoints delegate credential decisions to request-gate', async () => {
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
  assert.match(sources.me, /evaluateRequestAndLog\(input\)/);
  assert.match(sources.websocket, /evaluateRequestAndLog\(input\)/);
  assert.match(sources.proxy, /hasPresentedCredential\(input\)/);
});

test('Electron bypass branches remain above enforcing gate decisions', async () => {
  const paths = [entrypointPaths.api, entrypointPaths.me, entrypointPaths.websocket];

  for (const filePath of paths) {
    const source = await readFile(filePath, 'utf8');
    const bypassIndex = source.indexOf('if (isElectronAuthBypassEnabled())');
    const enforcementIndex = source.indexOf('evaluateRequestAndLog(input)', bypassIndex);

    assert.notEqual(bypassIndex, -1, filePath);
    assert.ok(enforcementIndex > bypassIndex, filePath);
  }
});

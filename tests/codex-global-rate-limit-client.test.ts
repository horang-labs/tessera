import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { fetchCodexRateLimitSnapshot } from '../src/lib/cli/providers/codex/rate-limit-client';
import { setCodexAppServerRequestExecutorForTests } from '../src/lib/cli/providers/codex/app-server-request-client';

afterEach(() => {
  setCodexAppServerRequestExecutorForTests(null);
});

test('reads Codex limits through an isolated app-server request without a session', async () => {
  let observedEnvironment = '';
  let observedMethod = '';
  let observedParams: Record<string, unknown> | null = null;
  setCodexAppServerRequestExecutorForTests(async (context, method, params) => {
    if (method === 'account/read') return { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
    observedEnvironment = context.environment ?? '';
    observedMethod = method;
    observedParams = params;
    return {
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          primary: {
            usedPercent: 48,
            windowDurationMins: 10080,
            resetsAt: 1_784_501_228,
          },
          secondary: null,
          planType: 'pro',
        },
      },
    };
  });

  const snapshot = await fetchCodexRateLimitSnapshot('wsl');

  assert.equal(observedEnvironment, 'wsl');
  assert.equal(observedMethod, 'account/rateLimits/read');
  assert.deepEqual(observedParams, {});
  assert.equal(snapshot?.providerId, 'codex');
  assert.equal(snapshot?.windows[0]?.usedPercent, 48);
  assert.equal(snapshot?.windows[0]?.windowDurationMins, 10080);
});

for (const account of [
  { account: { type: 'apiKey' }, requiresOpenaiAuth: true },
  { account: null, requiresOpenaiAuth: false },
  { account: { type: 'chatgpt' }, requiresOpenaiAuth: false },
]) {
  test(`clears subscription windows without fetching quotas: ${JSON.stringify(account)}`, async () => {
    const methods: string[] = [];
    setCodexAppServerRequestExecutorForTests(async (context, method) => {
      assert.equal(context.environment, 'wsl');
      methods.push(method);
      return account;
    });
    const snapshot = await fetchCodexRateLimitSnapshot('wsl');
    assert.deepEqual(snapshot?.windows, []);
    assert.deepEqual(methods, ['account/read']);
  });
}

import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  extractClaudeModels,
  refreshRemoteModelConfig,
  getClaudeModelOptions,
  __resetRemoteModelConfigForTests,
} from '../src/lib/model-config/remote-config.ts';

// Isolate the on-disk cache + telemetry state to a temp dir. getTesseraDataPath reads
// TESSERA_DATA_DIR inside the functions under test (not at import), so setting it here
// — after the hoisted imports, before any test runs — keeps tests off ~/.tessera.
process.env.TESSERA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-mc-'));

const HOST = {
  platform: 'darwin' as NodeJS.Platform,
  arch: 'arm64' as NodeJS.Architecture,
  appVersion: '9.9.9',
  channel: 'npm',
  telemetryDisabledByEnv: false,
  isWindowsEcosystem: false,
};

const validDoc = {
  version: 2,
  updatedAt: '2026-07-02T00:00:00Z',
  providers: {
    'claude-code': {
      displayName: 'Claude Code',
      models: [
        {
          value: 'claude-fable-5',
          label: 'claude-fable-5',
          isDefault: true,
          defaultReasoningEffort: 'auto',
          supportsFastMode: false,
          supportedReasoningEfforts: [
            { value: 'auto', label: 'Auto', description: 'CLI default' },
            { value: 'high', label: 'High', description: 'Deeper reasoning' },
          ],
        },
      ],
    },
  },
};

function mockFetch(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const jsonResponse = (doc: unknown, etag: string) =>
  new Response(JSON.stringify(doc), { status: 200, headers: { etag } });

test('extractClaudeModels parses a valid Worker document', () => {
  const result = extractClaudeModels(validDoc);
  assert.ok(result);
  assert.equal(result.version, 2);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].value, 'claude-fable-5');
  assert.equal(result.models[0].isDefault, true);
  assert.equal(result.models[0].supportedReasoningEfforts.length, 2);
});

test('normalization stamps requiresRestart on max (spawn-only) unless the Worker overrides it', () => {
  // `max` only exists as the spawn-only --effort flag (the apply_flag_settings
  // effortLevel enum stops at xhigh), so the client stamps it during normalization
  // rather than expecting the remote catalog to know about CLI transport limits.
  const result = extractClaudeModels({
    version: 3,
    providers: {
      'claude-code': {
        models: [{
          value: 'claude-opus-4-8',
          label: 'claude-opus-4-8',
          isDefault: false,
          supportedReasoningEfforts: [
            { value: 'high', label: 'High', description: '' },
            { value: 'max', label: 'Max', description: '' },
            { value: 'xhigh', label: 'Extra High', description: '', requiresRestart: false },
          ],
        }],
      },
    },
  });
  assert.ok(result);
  const efforts = result.models[0].supportedReasoningEfforts;
  assert.equal(efforts.find((e) => e.value === 'high')?.requiresRestart, undefined);
  assert.equal(efforts.find((e) => e.value === 'max')?.requiresRestart, true);
  assert.equal(efforts.find((e) => e.value === 'xhigh')?.requiresRestart, false);
});

test('extractClaudeModels rejects a missing/invalid version', () => {
  assert.equal(extractClaudeModels({ providers: { 'claude-code': { models: [] } } }), null);
  assert.equal(
    extractClaudeModels({ version: 1.5, providers: { 'claude-code': { models: [] } } }),
    null,
  );
});

test('extractClaudeModels rejects a malformed model (empty value)', () => {
  assert.equal(
    extractClaudeModels({
      version: 1,
      providers: { 'claude-code': { models: [{ value: '', label: 'x', supportedReasoningEfforts: [] }] } },
    }),
    null,
  );
});

test('extractClaudeModels rejects more than one default model', () => {
  const two = {
    version: 1,
    providers: {
      'claude-code': {
        models: [
          { value: 'a', label: 'a', isDefault: true, supportedReasoningEfforts: [] },
          { value: 'b', label: 'b', isDefault: true, supportedReasoningEfforts: [] },
        ],
      },
    },
  };
  assert.equal(extractClaudeModels(two), null);
});

test('refresh applies the remote list and reports changed', async () => {
  __resetRemoteModelConfigForTests();
  const { fn } = mockFetch(jsonResponse(validDoc, '"mc-2"'));
  const result = await refreshRemoteModelConfig('launch', { fetchImpl: fn, hostInfo: HOST });
  assert.equal(result.changed, true);
  assert.equal(getClaudeModelOptions()[0].value, 'claude-fable-5');
});

test('refresh sends install_id + host info headers (the launch count)', async () => {
  __resetRemoteModelConfigForTests();
  const { fn, calls } = mockFetch(jsonResponse(validDoc, '"mc-2"'));
  await refreshRemoteModelConfig('launch', { fetchImpl: fn, hostInfo: HOST });
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers['X-Tessera-Event'], 'launch');
  assert.equal(headers['X-Tessera-Version'], '9.9.9');
  assert.equal(headers['X-Tessera-Platform'], 'darwin');
  assert.equal(headers['X-Tessera-Arch'], 'arm64');
  assert.equal(headers['X-Tessera-Channel'], 'npm');
  assert.ok(headers['X-Tessera-Install-Id'], 'install id must be present');
});

test('a session-triggered refresh is labeled with the session event', async () => {
  __resetRemoteModelConfigForTests();
  const { fn, calls } = mockFetch(jsonResponse(validDoc, '"mc-2"'));
  await refreshRemoteModelConfig('session', { fetchImpl: fn, hostInfo: HOST });
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers['X-Tessera-Event'], 'session');
  assert.ok(headers['X-Tessera-Install-Id'], 'session events still carry the install id');
});

test('install_id is sent even when telemetry is disabled by env (full count, no gating)', async () => {
  __resetRemoteModelConfigForTests();
  const { fn, calls } = mockFetch(jsonResponse(validDoc, '"mc-2"'));
  await refreshRemoteModelConfig('launch', { fetchImpl: fn, hostInfo: { ...HOST, telemetryDisabledByEnv: true } });
  const headers = calls[0].init.headers as Record<string, string>;
  assert.ok(
    headers['X-Tessera-Install-Id'],
    'the config fetch IS the count — install id is sent regardless of the in-app/DNT gate',
  );
});

test('a 304 keeps the current list and reports not-changed', async () => {
  __resetRemoteModelConfigForTests();
  await refreshRemoteModelConfig('launch', { fetchImpl: mockFetch(jsonResponse(validDoc, '"mc-2"')).fn, hostInfo: HOST });
  const result = await refreshRemoteModelConfig('launch', {
    fetchImpl: mockFetch(new Response(null, { status: 304, headers: { etag: '"mc-2"' } })).fn,
    hostInfo: HOST,
  });
  assert.equal(result.changed, false);
  assert.equal(getClaudeModelOptions()[0].value, 'claude-fable-5');
});

test('an invalid payload leaves the list empty (no hardcoded fallback)', async () => {
  __resetRemoteModelConfigForTests();
  const result = await refreshRemoteModelConfig('launch', {
    fetchImpl: mockFetch(new Response('{"nope":true}', { status: 200 })).fn,
    hostInfo: HOST,
  });
  assert.equal(result.changed, false);
  assert.equal(getClaudeModelOptions().length, 0, 'no config → empty list, no hardcoded models');
});

test('a network error leaves the list empty (no hardcoded fallback)', async () => {
  __resetRemoteModelConfigForTests();
  const failing = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  const result = await refreshRemoteModelConfig('launch', { fetchImpl: failing, hostInfo: HOST });
  assert.equal(result.changed, false);
  assert.equal(getClaudeModelOptions().length, 0);
});

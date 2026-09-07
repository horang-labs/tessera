import assert from 'node:assert/strict';
import test from 'node:test';
import { hasClaudeSubscription, hasCodexSubscription } from '../src/lib/cli/subscription-auth';
import type { ExecResult } from '../src/lib/cli/cli-exec';

function probe(value: unknown, ok = true): ExecResult {
  return { ok, stdout: JSON.stringify(value), stderr: '', exitCode: ok ? 0 : 1, timedOut: false, durationMs: 1 };
}

test('Claude subscription is distinct from API, helper, bearer token and cloud provider authentication', () => {
  assert.equal(hasClaudeSubscription(probe({ authMethod: 'claude.ai', subscriptionType: 'max' })), true);
  assert.equal(hasClaudeSubscription(probe({ authMethod: 'claude.ai', subscriptionType: null })), false);
  for (const authMethod of ['api_key', 'api_key_helper', 'oauth_token', 'third_party']) {
    assert.equal(hasClaudeSubscription(probe({ loggedIn: true, authMethod, apiProvider: 'firstParty' })), false);
  }
  assert.equal(hasClaudeSubscription(probe({ authMethod: 'claude.ai', apiProvider: 'bedrock' })), false);
});

test('inconclusive auth probes do not declare an API billing switch', () => {
  assert.equal(hasClaudeSubscription(probe({ authMethod: 'none' }, false)), null);
  assert.equal(hasClaudeSubscription(probe({ authMethod: 'future-mode' })), null);
  assert.equal(hasCodexSubscription({}), null);
  assert.equal(hasCodexSubscription({ account: null, requiresOpenaiAuth: true }), null);
});

test('the active Codex provider takes precedence over a retained ChatGPT login', () => {
  assert.equal(hasCodexSubscription({ account: { type: 'chatgpt' }, requiresOpenaiAuth: false }), false);
  assert.equal(hasCodexSubscription({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true }), true);
  assert.equal(hasCodexSubscription({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }), false);
});

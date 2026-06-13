import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLAUDE_MODELS,
  buildClaudeSessionOptions,
} from '../src/lib/cli/provider-session-option-definitions';
import { resolveProviderReasoningEffort } from '../src/lib/settings/provider-defaults';

const opts = buildClaudeSessionOptions();
const model = (value: string) => CLAUDE_MODELS.find((m) => m.value === value);

test('ultracode is retained on a model that supports it', () => {
  const opus48 = model('claude-opus-4-8[1m]');
  assert.equal(resolveProviderReasoningEffort('claude-code', opts, opus48, 'ultracode'), 'ultracode');
});

test('switching to a claude model with no effort tiers drops stale ultracode', () => {
  // Haiku exposes no reasoning efforts — a leftover "ultracode" must not survive,
  // otherwise the adapter would emit --settings ultracode for a model that ignores it.
  const haiku = model('claude-haiku-4-5-20251001');
  assert.equal(resolveProviderReasoningEffort('claude-code', opts, haiku, 'ultracode'), null);
});

test('a custom claude model (no declared tiers) does not inherit stale ultracode', () => {
  const custom = {
    value: 'claude-future-9-9',
    label: 'claude-future-9-9',
    isDefault: false,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
  };
  assert.equal(resolveProviderReasoningEffort('claude-code', opts, custom, 'ultracode'), null);
});

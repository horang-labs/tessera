import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClaudeSessionOptions } from '../src/lib/cli/provider-session-option-definitions';
import { resolveProviderReasoningEffort } from '../src/lib/settings/provider-defaults';
import type { ProviderModelOption } from '../src/lib/cli/provider-session-option-types';

// The real model list comes from the remote config at runtime, so this tests the effort
// clamp logic against inline sample models rather than a hardcoded catalog.
const opts = buildClaudeSessionOptions();

const supportsUltracode: ProviderModelOption = {
  value: 'claude-opus-4-8[1m]',
  label: 'claude-opus-4-8[1m]',
  isDefault: true,
  defaultReasoningEffort: 'auto',
  supportedReasoningEfforts: [
    { value: 'ultracode', label: 'Ultracode', description: '' },
    { value: 'auto', label: 'Auto', description: '' },
    { value: 'xhigh', label: 'Extra High', description: '' },
    { value: 'max', label: 'Max', description: '' },
  ],
};

const noEffortTiers: ProviderModelOption = {
  value: 'claude-haiku-4-5-20251001',
  label: 'claude-haiku-4-5-20251001',
  isDefault: false,
  supportedReasoningEfforts: [],
};

test('ultracode is retained on a model that supports it', () => {
  assert.equal(resolveProviderReasoningEffort('claude-code', opts, supportsUltracode, 'ultracode'), 'ultracode');
});

test('switching to a claude model with no effort tiers drops stale ultracode', () => {
  // A model that exposes no reasoning efforts must not keep a leftover "ultracode",
  // otherwise the adapter would emit --settings ultracode for a model that ignores it.
  assert.equal(resolveProviderReasoningEffort('claude-code', opts, noEffortTiers, 'ultracode'), null);
});

test('a custom claude model (no declared tiers) does not inherit stale ultracode', () => {
  const custom: ProviderModelOption = {
    value: 'claude-future-9-9',
    label: 'claude-future-9-9',
    isDefault: false,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
  };
  assert.equal(resolveProviderReasoningEffort('claude-code', opts, custom, 'ultracode'), null);
});

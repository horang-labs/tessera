import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODEX_DEFAULT_SERVICE_TIER,
  getCodexFastToggleServiceTier,
  isCodexFastModeEnabled,
  resolveCodexServiceTierForModel,
} from '../src/lib/chat/codex-fast-command';
import type { ProviderModelOption } from '../src/lib/cli/provider-session-option-types';

function model(defaultServiceTier: string | null = null): ProviderModelOption {
  return {
    value: 'test-model',
    label: 'Test Model',
    isDefault: true,
    supportedReasoningEfforts: [],
    defaultServiceTier,
    serviceTiers: [{ value: 'turbo-v2', label: 'Fast', description: '' }],
  };
}

test('Fast toggles the catalog tier id and explicit default sentinel', () => {
  assert.equal(getCodexFastToggleServiceTier(undefined, model()), 'turbo-v2');
  assert.equal(getCodexFastToggleServiceTier('turbo-v2', model()), CODEX_DEFAULT_SERVICE_TIER);
});

test('catalog default Fast is effective until explicitly opted out', () => {
  assert.equal(isCodexFastModeEnabled(undefined, model('turbo-v2')), true);
  assert.equal(isCodexFastModeEnabled(CODEX_DEFAULT_SERVICE_TIER, model('turbo-v2')), false);
});

test('unsupported stored preferences are preserved by callers but not sent', () => {
  const unsupported = { ...model(), serviceTiers: [] };
  assert.equal(resolveCodexServiceTierForModel('turbo-v2', unsupported), CODEX_DEFAULT_SERVICE_TIER);
});

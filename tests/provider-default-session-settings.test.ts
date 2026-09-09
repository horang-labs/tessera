import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { ProviderSessionOptions } from '@/lib/cli/provider-session-option-types';
import {
  buildProviderSessionDefaultsUpdate,
  getProviderSessionDefaultsWithOptions,
  normalizeUserSettings,
} from '@/lib/settings/provider-defaults';

const codexOptions: ProviderSessionOptions = {
  providerId: 'codex',
  displayName: 'Codex',
  supportsReasoningEffort: true,
  runtimeEffortChange: true,
  modelOptions: [
    {
      value: 'gpt-default',
      label: 'GPT Default',
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [
        { value: 'low', label: 'Low', description: '' },
        { value: 'medium', label: 'Medium', description: '' },
      ],
    },
    {
      value: 'gpt-reasoning',
      label: 'GPT Reasoning',
      isDefault: false,
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [
        { value: 'high', label: 'High', description: '' },
      ],
    },
  ],
  permissionMappings: [],
  modeOptions: [],
  accessOptions: [],
  planLocksAccess: false,
};

test('provider default edits keep providers isolated and retain Claude legacy compatibility', () => {
  const settings = normalizeUserSettings({
    providerDefaults: {
      codex: { model: 'gpt-default', reasoningEffort: 'low' },
      opencode: { model: 'openai/gpt-5', reasoningEffort: 'high' },
    },
  });
  const updated = buildProviderSessionDefaultsUpdate(settings, 'codex', {
    model: 'gpt-reasoning',
    reasoningEffort: 'high',
  });

  assert.deepEqual(updated.providerDefaults?.codex, {
    ...settings.providerDefaults.codex,
    model: 'gpt-reasoning',
    reasoningEffort: 'high',
  });
  assert.deepEqual(updated.providerDefaults?.opencode, settings.providerDefaults.opencode);

  const claudeUpdate = buildProviderSessionDefaultsUpdate(settings, 'claude-code', {
    model: 'claude-opus',
  });
  assert.equal(claudeUpdate.defaultModel, 'claude-opus');

  const clearedClaude = normalizeUserSettings({
    ...settings,
    ...buildProviderSessionDefaultsUpdate(
      normalizeUserSettings({ defaultModel: 'claude-opus' }),
      'claude-code',
      { model: '' },
    ),
  });
  assert.equal(clearedClaude.defaultModel, '');
  assert.equal(clearedClaude.providerDefaults['claude-code'].model, '');
});

test('stored thinking intensity falls back to a model-supported value', () => {
  const settings = normalizeUserSettings({
    providerDefaults: {
      codex: { model: 'gpt-reasoning', reasoningEffort: 'low' },
    },
  });

  const resolved = getProviderSessionDefaultsWithOptions(settings, 'codex', codexOptions);
  assert.equal(resolved.model, 'gpt-reasoning');
  assert.equal(resolved.reasoningEffort, 'high');
});

test('provider default settings use the configured agent environment and dynamic session options', () => {
  const source = fs.readFileSync(
    new URL('../src/components/settings/provider-default-session-settings.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /useProviderSessionOptions\(\s*providerId,\s*settings\.agentEnvironment/);
  assert.match(source, /sessionOptions\?\.modelOptions/);
  assert.match(source, /selectedModelOption\?\.supportedReasoningEfforts/);
  assert.match(source, /buildProviderSessionDefaultsUpdate/);
  assert.match(source, /resolveProviderReasoningEffort/);
});

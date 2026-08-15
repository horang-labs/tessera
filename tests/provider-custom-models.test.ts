import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeCustomModelIds } from '@/lib/cli/provider-session-custom-models';
import { mergeClaudeConfiguredModels } from '@/lib/cli/provider-session-options-claude';
import type {
  ProviderModelOption,
  ProviderSessionOptions,
} from '@/lib/cli/provider-session-option-types';
import {
  normalizeProviderCustomModelList,
  normalizeUserSettings,
} from '@/lib/settings/provider-defaults';

function model(value: string, overrides: Partial<ProviderModelOption> = {}): ProviderModelOption {
  return {
    value,
    label: value,
    isDefault: false,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    ...overrides,
  };
}

function sessionOptions(modelOptions: ProviderModelOption[]): ProviderSessionOptions {
  return {
    providerId: 'codex',
    displayName: 'Codex',
    supportsReasoningEffort: true,
    runtimeEffortChange: true,
    modelOptions,
    permissionMappings: [],
    modeOptions: [],
    accessOptions: [],
    planLocksAccess: false,
  };
}

test('custom model settings trim, deduplicate, and discard invalid values', () => {
  assert.deepEqual(
    normalizeProviderCustomModelList([' deepseek-v3 ', '', 'deepseek-v3', 42, 'kimi-k2']),
    ['deepseek-v3', 'kimi-k2'],
  );

  const settings = normalizeUserSettings({
    providerCustomModels: {
      ' claude-code ': [' deepseek-v3 ', 'deepseek-v3'],
      codex: [],
    },
  });
  assert.deepEqual(settings.providerCustomModels, {
    'claude-code': ['deepseek-v3'],
  });
});

test('manual model IDs merge without inventing reasoning or Fast capabilities', () => {
  const advertised = model('advertised', {
    supportedReasoningEfforts: [
      { value: 'high', label: 'High', description: 'Advertised by CLI' },
    ],
    serviceTiers: [
      { value: 'fast', label: 'Fast', description: 'Advertised by CLI' },
    ],
  });
  const merged = mergeCustomModelIds(
    sessionOptions([advertised]),
    [' advertised ', ' deepseek-v3 ', 'deepseek-v3'],
  );

  assert.equal(merged.modelOptions.length, 2);
  assert.equal(merged.modelOptions[0], advertised);
  assert.deepEqual(merged.modelOptions[1], {
    value: 'deepseek-v3',
    label: 'deepseek-v3',
    isDefault: false,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
  });
});

test('Claude settings aliases expose only explicitly advertised effort levels', () => {
  const merged = mergeClaudeConfiguredModels(
    [model('claude-sonnet', { isDefault: true })],
    {
      model: 'sonnet',
      env: {
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v3',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'DeepSeek V3',
        ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: 'CC Switch active model',
        ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES:
          'effort,xhigh_effort,max_effort,thinking,adaptive_thinking',
      },
    },
    {},
  );

  const deepseek = merged.find((entry) => entry.value === 'deepseek-v3');
  assert.ok(deepseek);
  assert.equal(deepseek.label, 'DeepSeek V3');
  assert.equal(deepseek.description, 'CC Switch active model');
  assert.equal(deepseek.isDefault, true);
  assert.equal(deepseek.defaultReasoningEffort, 'auto');
  assert.deepEqual(
    deepseek.supportedReasoningEfforts.map((effort) => effort.value),
    ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
  );
  assert.equal(deepseek.supportedReasoningEfforts.at(-1)?.requiresRestart, true);
  assert.equal(deepseek.supportsFastMode, undefined);
  assert.equal(merged.find((entry) => entry.value === 'claude-sonnet')?.isDefault, false);
});

test('Claude configured models without a capability list stay capability-free', () => {
  const merged = mergeClaudeConfiguredModels(
    [],
    {
      env: {
        ANTHROPIC_CUSTOM_MODEL_OPTION: 'kimi-k2',
        ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'Kimi K2',
      },
    },
    {},
  );

  assert.deepEqual(merged, [
    {
      value: 'kimi-k2',
      label: 'Kimi K2',
      isDefault: false,
      defaultReasoningEffort: null,
      supportedReasoningEfforts: [],
    },
  ]);
});

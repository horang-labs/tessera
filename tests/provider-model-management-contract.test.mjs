import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const settingsTypesSource = fs.readFileSync(new URL('../src/lib/settings/types.ts', import.meta.url), 'utf8');
const providerDefaultsSource = fs.readFileSync(new URL('../src/lib/settings/provider-defaults.ts', import.meta.url), 'utf8');
const providerSessionOptionsSource = fs.readFileSync(new URL('../src/lib/cli/provider-session-options.ts', import.meta.url), 'utf8');
const providerSessionOptionsRouteSource = fs.readFileSync(new URL('../src/app/api/providers/session-options/route.ts', import.meta.url), 'utf8');
const providerSessionOptionsHookSource = fs.readFileSync(new URL('../src/hooks/use-provider-session-options.ts', import.meta.url), 'utf8');
const settingsRouteSource = fs.readFileSync(new URL('../src/app/api/settings/route.ts', import.meta.url), 'utf8');
const settingsPanelSource = fs.readFileSync(new URL('../src/components/settings/settings-panel.tsx', import.meta.url), 'utf8');
const composerSource = fs.readFileSync(new URL('../src/components/chat/composer-session-controls.tsx', import.meta.url), 'utf8');
const composerMenuSource = fs.readFileSync(new URL('../src/components/chat/composer-session-control-sections.tsx', import.meta.url), 'utf8');
const claudeAdapterSource = fs.readFileSync(new URL('../src/lib/cli/providers/claude-code/adapter.ts', import.meta.url), 'utf8');

test('settings persist custom model IDs per provider and normalize them before saving', () => {
  assert.match(settingsTypesSource, /providerCustomModels:\s*Record<string,\s*string\[\]>/);
  assert.match(providerDefaultsSource, /function normalizeProviderCustomModels/);
  assert.match(providerDefaultsSource, /\.trim\(\)/);
  assert.match(providerDefaultsSource, /new Set<string>\(\)/);
  assert.match(providerDefaultsSource, /providerCustomModels/);
});

test('provider session options merge discovered models with saved custom models', () => {
  assert.match(providerSessionOptionsSource, /mergeProviderModelOptions/);
  assert.match(providerSessionOptionsSource, /providerCustomModels/);
  assert.match(providerSessionOptionsSource, /custom model/i);
  assert.match(providerSessionOptionsSource, /modelOptions:\s*mergeProviderModelOptions/);
  assert.match(providerSessionOptionsSource, /getCustomModelReasoningEfforts/);
  assert.match(providerSessionOptionsSource, /providerId === 'claude-code'/);
});

test('provider session options keep custom models when dynamic discovery fails', () => {
  assert.match(providerSessionOptionsSource, /buildProviderSessionOptionsFallback/);
  assert.match(providerSessionOptionsSource, /\.catch\(\(error\) =>/);
  assert.match(providerSessionOptionsSource, /logger\.warn/);
  assert.match(providerSessionOptionsSource, /loadProviderSessionOptions\(providerId, userId, agentEnvironment\)[\s\S]*catch/);
});

test('defaults can resolve to custom model IDs after model option merging', () => {
  assert.match(providerDefaultsSource, /resolveProviderModelOption/);
  assert.match(providerDefaultsSource, /requestedModel/);
  assert.match(providerDefaultsSource, /modelOptions\.find\(\(option\) => option\.value === normalizedRequestedModel\)/);
});

test('settings exposes a Models tab with add/remove custom model controls', () => {
  assert.match(settingsPanelSource, /settings\.sections\.models/);
  assert.match(settingsPanelSource, /ModelSettings/);
  assert.match(settingsPanelSource, /data-testid=\{`settings-nav-\$\{section\.id\}`\}/);
  const modelSettingsPath = new URL('../src/components/settings/model-settings.tsx', import.meta.url);
  const modelSettingsSource = fs.readFileSync(modelSettingsPath, 'utf8');
  assert.match(modelSettingsSource, /providerCustomModels/);
  assert.match(modelSettingsSource, /addCustomModel/);
  assert.match(modelSettingsSource, /removeCustomModel/);
  assert.match(modelSettingsSource, /refreshModels/);
  assert.match(modelSettingsSource, /buildProviderSessionDefaultsUpdate/);
});

test('model refresh clears client and server provider option caches', () => {
  assert.match(providerSessionOptionsHookSource, /invalidateProviderSessionOptionsClientCache/);
  assert.match(providerSessionOptionsHookSource, /forceRefresh/);
  assert.match(providerSessionOptionsHookSource, /params\.set\('refresh', '1'\)/);
  assert.match(providerSessionOptionsRouteSource, /searchParams\.get\('refresh'\) === '1'/);
  assert.match(providerSessionOptionsRouteSource, /invalidateProviderSessionOptionsCache\(auth\.userId\)/);
  assert.match(settingsRouteSource, /providerCustomModels/);
  assert.match(settingsRouteSource, /invalidateProviderSessionOptionsCache\(userId\)/);
});

test('composer selector remains a closed list and does not expose free-text model editing', () => {
  assert.match(composerMenuSource, /modelOptions\.map/);
  assert.match(composerSource, /providerCustomModelVersion/);
  assert.match(composerSource, /cacheKeySuffix:\s*providerCustomModelVersion/);
  assert.doesNotMatch(composerMenuSource, /placeholder=.*model/i);
  assert.doesNotMatch(composerMenuSource, /onChange=.*model/i);
});

test('Claude Code adapter passes arbitrary selected model IDs through to CLI args', () => {
  assert.match(claudeAdapterSource, /if \(model\) \{[\s\S]*args\.push\('--model', model\);[\s\S]*\}/);
  assert.doesNotMatch(claudeAdapterSource, /CLAUDE_MODELS/);
});

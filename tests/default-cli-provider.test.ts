import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCliProviderSelection } from '@/components/chat/cli-provider-chip-selector';
import { normalizeUserSettings } from '@/lib/settings/provider-defaults';

test('new and invalid settings use Claude Code as the default CLI provider', () => {
  assert.equal(normalizeUserSettings({}).defaultCliProvider, 'claude-code');
  assert.equal(
    normalizeUserSettings({ defaultCliProvider: '' as never }).defaultCliProvider,
    'claude-code',
  );
  assert.equal(
    normalizeUserSettings({ defaultCliProvider: 'unknown' as never }).defaultCliProvider,
    'claude-code',
  );
});

test('persisted built-in CLI provider defaults survive normalization', () => {
  assert.equal(
    normalizeUserSettings({ defaultCliProvider: 'codex' }).defaultCliProvider,
    'codex',
  );
  assert.equal(
    normalizeUserSettings({ defaultCliProvider: 'opencode' }).defaultCliProvider,
    'opencode',
  );
});

test('an untouched creation surface prefers the configured connected provider', () => {
  assert.equal(
    resolveCliProviderSelection({
      selectableProviderIds: ['claude-code', 'codex', 'opencode'],
      currentProviderId: 'claude-code',
      preferredProviderId: 'codex',
      selectionTouched: false,
    }),
    'codex',
  );
});

test('a valid manual selection outranks the configured provider', () => {
  assert.equal(
    resolveCliProviderSelection({
      selectableProviderIds: ['claude-code', 'codex', 'opencode'],
      currentProviderId: 'opencode',
      preferredProviderId: 'codex',
      selectionTouched: true,
    }),
    'opencode',
  );
});

test('an unavailable configured provider falls back to the first connected provider', () => {
  assert.equal(
    resolveCliProviderSelection({
      selectableProviderIds: ['claude-code', 'opencode'],
      currentProviderId: '',
      preferredProviderId: 'codex',
      selectionTouched: false,
    }),
    'claude-code',
  );
});

test('an empty provider refresh preserves the current selection', () => {
  assert.equal(
    resolveCliProviderSelection({
      selectableProviderIds: [],
      currentProviderId: 'codex',
      preferredProviderId: 'claude-code',
      selectionTouched: false,
    }),
    'codex',
  );
});

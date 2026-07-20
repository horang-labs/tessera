import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClaudeHookSettingsJson } from '@/lib/terminal/claude-hook-settings';
import { buildCodexHookSettingsJson } from '@/lib/terminal/codex-hook-settings';
import {
  buildOpenCodeHookPluginSource,
  OPENCODE_TESSERA_LIFECYCLE_EVENTS,
} from '@/lib/terminal/opencode-hook-plugin';

const EXPECTED_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'];

function hooks(settingsJson: string): Record<string, unknown> {
  const settings = JSON.parse(settingsJson) as { hooks?: unknown };
  assert.ok(settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks));
  return settings.hooks as Record<string, unknown>;
}

function assertMinimalEvents(actual: Record<string, unknown>): void {
  assert.deepEqual(Object.keys(actual).sort(), [...EXPECTED_EVENTS].sort());
}

test('Claude terminal settings inject only the minimal lifecycle hooks', () => {
  assertMinimalEvents(hooks(buildClaudeHookSettingsJson()));
});

test('Codex terminal overlay injects the same minimal lifecycle hooks as Claude', () => {
  const claudeHooks = hooks(buildClaudeHookSettingsJson());
  const codexHooks = hooks(buildCodexHookSettingsJson());
  assertMinimalEvents(codexHooks);
  assert.deepEqual(codexHooks, claudeHooks);
});

test('OpenCode terminal plugin normalizes to the same minimal lifecycle events', () => {
  assert.deepEqual([...OPENCODE_TESSERA_LIFECYCLE_EVENTS], EXPECTED_EVENTS);
  const emittedEvents = [...buildOpenCodeHookPluginSource().matchAll(/hook_event_name:\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(emittedEvents)].sort(), [...EXPECTED_EVENTS].sort());
});

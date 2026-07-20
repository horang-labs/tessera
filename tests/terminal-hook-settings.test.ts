import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClaudeHookSettingsJson } from '@/lib/terminal/claude-hook-settings';
import { buildCodexHookSettingsJson } from '@/lib/terminal/codex-hook-settings';
import {
  buildOpenCodeHookPluginSource,
  OPENCODE_TESSERA_LIFECYCLE_EVENTS,
} from '@/lib/terminal/opencode-hook-plugin';

const BASE_LIFECYCLE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'];
const CLAUDE_LIFECYCLE_EVENTS = [
  ...BASE_LIFECYCLE_EVENTS,
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
];

function hooks(settingsJson: string): Record<string, unknown> {
  const settings = JSON.parse(settingsJson) as { hooks?: unknown };
  assert.ok(settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks));
  return settings.hooks as Record<string, unknown>;
}

function assertEvents(actual: Record<string, unknown>, expected: string[]): void {
  assert.deepEqual(Object.keys(actual).sort(), [...expected].sort());
}

test('Claude terminal settings include child-agent lifecycle hooks', () => {
  assertEvents(hooks(buildClaudeHookSettingsJson()), CLAUDE_LIFECYCLE_EVENTS);
});

test('Codex terminal overlay keeps the base lifecycle hooks', () => {
  const codexHooks = hooks(buildCodexHookSettingsJson());
  assertEvents(codexHooks, BASE_LIFECYCLE_EVENTS);
});

test('OpenCode terminal plugin normalizes to the base lifecycle events', () => {
  assert.deepEqual([...OPENCODE_TESSERA_LIFECYCLE_EVENTS], BASE_LIFECYCLE_EVENTS);
  const emittedEvents = [...buildOpenCodeHookPluginSource().matchAll(/hook_event_name:\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(emittedEvents)].sort(), [...BASE_LIFECYCLE_EVENTS].sort());
});

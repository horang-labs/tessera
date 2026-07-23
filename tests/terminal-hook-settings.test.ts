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
  // 에러로 정상 Stop을 건너뛴 턴을 닫기 위한 이벤트.
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  // 도구 활동 신호. 백그라운드 작업 완료로 깨어난 재기동 턴(UserPromptSubmit 없음)의
  // 유일한 감지 수단이라 모든 도구('*')에 발화한다. AskUserQuestion 분류도 겸한다.
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
];
const CODEX_LIFECYCLE_EVENTS = [
  ...BASE_LIFECYCLE_EVENTS,
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
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

test('Claude tool hooks fire for every tool to detect background-revived turns', () => {
  const claudeHooks = hooks(buildClaudeHookSettingsJson()) as Record<
    string,
    Array<{ matcher?: string }>
  >;
  assert.equal(claudeHooks.PreToolUse[0]?.matcher, '*');
  assert.equal(claudeHooks.PostToolUse[0]?.matcher, '*');
  assert.equal(claudeHooks.PostToolUseFailure[0]?.matcher, '*');
  assert.equal(claudeHooks.PermissionRequest[0]?.matcher, '*');
  // lifecycle hook들은 matcher가 없어야 한다(모든 발생에 발화).
  assert.equal(claudeHooks.Stop[0]?.matcher, undefined);
});

test('Codex terminal overlay observes tool progress and permission requests', () => {
  const codexHooks = hooks(buildCodexHookSettingsJson());
  assertEvents(codexHooks, CODEX_LIFECYCLE_EVENTS);
  assert.equal((codexHooks.PermissionRequest as Array<{ matcher?: string }>)[0]?.matcher, undefined);
});

test('OpenCode terminal plugin emits its declared lifecycle and input-wait events', () => {
  const emittedEvents = [...buildOpenCodeHookPluginSource().matchAll(/hook_event_name:\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(
    [...new Set(emittedEvents)].sort(),
    [...OPENCODE_TESSERA_LIFECYCLE_EVENTS].sort(),
  );
});

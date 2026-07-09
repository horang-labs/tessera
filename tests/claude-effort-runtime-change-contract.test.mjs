import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// Claude Code effort/ultracode can change mid-session via the apply_flag_settings
// control_request — the same mechanism the CLI's own /effort command uses. The
// one exception is `max`: it only exists as the spawn-only --effort flag (the
// settings effortLevel enum stops at xhigh and silently drops unknown values),
// so it is disabled in the selector while a session runs.

test('ProcessManager.sendSetReasoningEffort falls back to apply_flag_settings', () => {
  const processManagerSource = read('src/lib/cli/process-manager.ts');

  assert.match(processManagerSource, /sendSetReasoningEffort\(sessionId: string, reasoningEffort: string \| null\): boolean/);
  // ultracode on → effortLevel cleared; plain effort → ultracode cleared; auto/null → both cleared
  assert.match(processManagerSource, /\? \{ ultracode: true, effortLevel: null \}/);
  assert.match(processManagerSource, /effortLevel: reasoningEffort && reasoningEffort !== 'auto' \? reasoningEffort : null/);
  assert.match(processManagerSource, /ultracode: null/);
  assert.match(processManagerSource, /\{ subtype: 'apply_flag_settings', settings \}/);
  // max would be silently dropped by the CLI (success response, no effect) — reject before sending
  assert.match(processManagerSource, /if \(reasoningEffort === 'max'\) \{\s*logger\.warn/);
  assert.match(processManagerSource, /info\.reasoningEffort = reasoningEffort/);
});

test('claude-code declares runtime effort change with max as spawn-only', () => {
  const definitionsSource = read('src/lib/cli/provider-session-option-definitions.ts');
  const typesSource = read('src/lib/cli/provider-session-option-types.ts');
  const remoteConfigSource = read('src/lib/model-config/remote-config.ts');

  assert.match(typesSource, /requiresRestart\?: boolean/);
  // the model catalog is remote (PR #123), so requiresRestart is stamped during
  // effort normalization: max defaults to spawn-only, Worker value wins if sent
  assert.match(remoteConfigSource, /typeof r\.requiresRestart === 'boolean'/);
  assert.match(remoteConfigSource, /else if \(value === 'max'\) \{\s*effort\.requiresRestart = true;/);
  // buildClaudeSessionOptions unlocks the runtime dropdown
  assert.match(definitionsSource, /runtimeEffortChange: true,\s*runtimeAccessChange: true/);
});

test('spawn passes plain effort through settings.effortLevel so the flag cannot shadow runtime changes', () => {
  const adapterSource = read('src/lib/cli/providers/claude-code/adapter.ts');

  assert.match(adapterSource, /settings\.effortLevel = reasoningEffort/);
  // max stays a --effort flag (spawn-only)
  assert.match(adapterSource, /reasoningEffort === 'max'\) \{\s*args\.push\('--effort', reasoningEffort\)/);
});

test('composer disables spawn-only efforts while running and locks max-spawned sessions', () => {
  const composer = read('src/components/chat/composer-session-controls.tsx');
  const sections = read('src/components/chat/composer-session-control-sections.tsx');

  // menu supports per-option disabling with a tooltip
  assert.match(sections, /disableRestartRequired\?: boolean/);
  assert.match(sections, /restartRequiredTooltip\?: string/);
  assert.match(sections, /disableRestartRequired === true && option\.requiresRestart === true/);

  // composer wires it to the running state + i18n tooltip
  assert.match(composer, /disableRestartRequired=\{session\?\.isRunning === true\}/);
  assert.match(composer, /restartRequiredTooltip=\{t\('settings\.effort\.requiresRestartTooltip'\)\}/);

  // a session spawned with --effort max keeps the read-only badge (flag outranks runtime changes)
  assert.match(composer, /const isEffortSpawnLocked = Boolean\(/);
  assert.match(composer, /sessionOptions\.runtimeEffortChange && !isEffortSpawnLocked/);

  // live change requests skip spawn-only levels instead of surfacing failures
  assert.match(composer, /\?\.requiresRestart === true;\s*if \(!requiresRestart\) \{\s*wsClient\.setReasoningEffort\(sessionId, nextReasoningEffort\);/);
});

test('requiresRestart tooltip exists in every locale', () => {
  for (const locale of ['en', 'ko', 'ja', 'zh']) {
    const source = read(`src/lib/i18n/${locale}.ts`);
    assert.match(source, /requiresRestartTooltip: '/, `${locale}.ts must define requiresRestartTooltip`);
  }
  assert.match(read('src/lib/i18n/types.ts'), /requiresRestartTooltip: string/);
});

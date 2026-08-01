import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveSessionCreationExecutionMode,
} from '@/lib/session/agent-execution-mode';
import {
  getExecutionModeSelectorOptions,
} from '@/components/session/execution-mode-selector';
import {
  resolveEmptyPanelProjectId,
  shouldLaunchFromEmptyPanelShortcut,
} from '@/components/panel/empty-panel-state';
import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';
import { getInitialTerminalCwd } from '@/lib/terminal/client-terminal-cwd';
import {
  shouldSubmitCollectionQuickCreateFromModeShortcut,
} from '@/components/chat/collection-quick-create-sheet';
import {
  getQuickMenuExecutionCapabilities,
  resolveQuickMenuExecutionMode,
} from '@/components/chat/provider-quick-menu';

test('an explicit supported execution mode overrides the global default for one session', () => {
  assert.equal(
    resolveSessionCreationExecutionMode('gui', 'pty', { pty: true, gui: true }),
    'gui',
  );
});

test('an explicit unsupported execution mode is rejected instead of silently switching', () => {
  assert.throws(
    () => resolveSessionCreationExecutionMode('gui', 'pty', { pty: true, gui: false }),
    /does not support gui execution mode/,
  );
});

test('legacy callers without a per-session mode still use the compatible global default', () => {
  assert.equal(
    resolveSessionCreationExecutionMode(undefined, 'gui', { pty: true, gui: false }),
    'pty',
  );
});

test('execution mode selector exposes checked and disabled native radio options', () => {
  assert.deepEqual(
    getExecutionModeSelectorOptions('pty', { pty: true, gui: false }),
    [
      { mode: 'pty', checked: true, disabled: false },
      { mode: 'gui', checked: false, disabled: true },
    ],
  );
});

test('Space launches from a focused execution-mode radio without enabling text-input shortcuts', () => {
  assert.equal(shouldLaunchFromEmptyPanelShortcut(' ', 'execution-mode-radio'), true);
  assert.equal(shouldLaunchFromEmptyPanelShortcut(' ', 'text-entry'), false);
  assert.equal(shouldLaunchFromEmptyPanelShortcut('x', 'execution-mode-radio'), false);
});

test('All Projects requires an explicit launcher project while a project scope resolves itself', () => {
  assert.equal(resolveEmptyPanelProjectId(ALL_PROJECTS_SENTINEL, null), null);
  assert.equal(
    resolveEmptyPanelProjectId(ALL_PROJECTS_SENTINEL, 'project-b'),
    'project-b',
  );
  assert.equal(resolveEmptyPanelProjectId('project-a', null), 'project-a');
});

test('a standalone shell honors the project cwd selected in the launcher', () => {
  assert.equal(
    getInitialTerminalCwd(null, '/workspace/project-b'),
    '/workspace/project-b',
  );
});

test('Space submits collection quick create from its focused execution-mode radio', () => {
  assert.equal(
    shouldSubmitCollectionQuickCreateFromModeShortcut({
      key: ' ',
      repeat: false,
      targetTagName: 'INPUT',
      targetType: 'radio',
      targetName: 'collection-execution-mode-other',
      executionModeInputName: 'collection-execution-mode-other',
    }),
    true,
  );
  assert.equal(
    shouldSubmitCollectionQuickCreateFromModeShortcut({
      key: ' ',
      repeat: false,
      targetTagName: 'INPUT',
      targetType: 'text',
      targetName: '',
      executionModeInputName: 'collection-execution-mode-other',
    }),
    false,
  );
  assert.equal(
    shouldSubmitCollectionQuickCreateFromModeShortcut({
      key: ' ',
      repeat: true,
      targetTagName: 'INPUT',
      targetType: 'radio',
      targetName: 'collection-execution-mode-other',
      executionModeInputName: 'collection-execution-mode-other',
    }),
    false,
  );
});

test('the add-session menu offers a mode as long as one listed provider can run it', () => {
  assert.deepEqual(
    getQuickMenuExecutionCapabilities(['claude-code', 'codex', 'opencode']),
    { pty: true, gui: true },
  );
  assert.deepEqual(getQuickMenuExecutionCapabilities([]), { pty: false, gui: false });
  assert.deepEqual(
    getQuickMenuExecutionCapabilities(['unknown-provider']),
    { pty: false, gui: false },
  );
});

test('the add-session menu keeps the global default when the listed providers support it', () => {
  assert.equal(resolveQuickMenuExecutionMode('gui', { pty: true, gui: true }), 'gui');
  assert.equal(resolveQuickMenuExecutionMode('pty', { pty: true, gui: true }), 'pty');
});

test('the add-session menu falls back rather than disabling every provider it lists', () => {
  assert.equal(resolveQuickMenuExecutionMode('gui', { pty: true, gui: false }), 'pty');
  assert.equal(resolveQuickMenuExecutionMode('pty', { pty: false, gui: true }), 'gui');
  // Nothing runnable to fall back to (empty/unknown list) — keep the request as-is
  // instead of throwing while the menu renders its empty state.
  assert.equal(resolveQuickMenuExecutionMode('gui', { pty: false, gui: false }), 'gui');
});

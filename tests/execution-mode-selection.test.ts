import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveSessionCreationExecutionMode,
} from '@/lib/session/agent-execution-mode';
import {
  getExecutionModeSelectorOptions,
} from '@/components/session/execution-mode-selector';
import {
  shouldLaunchFromEmptyPanelShortcut,
} from '@/components/panel/empty-panel-state';
import {
  shouldSubmitCollectionQuickCreateFromModeShortcut,
} from '@/components/chat/collection-quick-create-sheet';

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

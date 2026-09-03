import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';
import {
  buildWebContentsContextMenuTemplate,
  resolveTerminalPanelAtPoint,
} from '../electron/web-contents-context-menu';

function editableParams(): ContextMenuParams {
  return {
    isEditable: true,
    selectionText: '',
    editFlags: {
      canUndo: true,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canDelete: true,
      canSelectAll: true,
    },
  } as ContextMenuParams;
}

test('replaces native edit actions with terminal-only view and split actions', () => {
  const splits: string[] = [];
  const viewModes: string[] = [];
  const template = buildWebContentsContextMenuTemplate(editableParams(), {
    panelId: 'panel-1',
    onSplit: (panelId, placement) => splits.push(`${panelId}:${placement}`),
    viewMode: 'terminal',
    onSwitchView: (panelId, mode) => viewModes.push(`${panelId}:${mode}`),
  });

  assert.equal(template.length, 3);
  assert.equal(template[0]?.label, 'Switch to Chat View');
  assert.equal(template[1]?.type, 'separator');
  const splitMenu = template.at(-1);
  assert.equal(splitMenu?.label, 'Split Panel');

  const submenu = splitMenu?.submenu as MenuItemConstructorOptions[];
  assert.deepEqual(submenu.map((item) => item.label), [
    'New Panel on Left',
    'New Panel on Right',
    'New Panel Above',
    'New Panel Below',
  ]);
  (submenu[0].click as () => void)();
  (submenu[3].click as () => void)();
  (template[0].click as () => void)();
  assert.deepEqual(splits, ['panel-1:left', 'panel-1:down']);
  assert.deepEqual(viewModes, ['panel-1:chat']);
  assert.equal(template.some((item) => item.role === 'undo' || item.role === 'copy'), false);
});

test('offers the reverse transition while the terminal chat view is visible', () => {
  const viewModes: string[] = [];
  const template = buildWebContentsContextMenuTemplate(editableParams(), {
    panelId: 'panel-1',
    viewMode: 'chat',
    onSwitchView: (panelId, mode) => viewModes.push(`${panelId}:${mode}`),
    onSplit: () => undefined,
  });

  assert.equal(template[0]?.label, 'Switch to PTY View');
  (template[0].click as () => void)();
  assert.deepEqual(viewModes, ['panel-1:terminal']);
});

test('keeps the existing native menu unchanged outside a terminal panel', () => {
  const template = buildWebContentsContextMenuTemplate(editableParams());
  assert.equal(template.at(-1)?.role, 'selectAll');
  assert.equal(template.some((item) => item.label === 'Split panel'), false);
});

test('resolves only panel ids returned by the matching terminal wrapper query', async () => {
  let evaluated = '';
  const frame = {
    isDestroyed: () => false,
    executeJavaScript: async (script: string) => {
      evaluated = script;
      return { panelId: 'panel-1', viewMode: 'chat' };
    },
  };

  assert.deepEqual(await resolveTerminalPanelAtPoint(frame, 42, 84), {
    panelId: 'panel-1',
    viewMode: 'chat',
  });
  assert.match(evaluated, /elementFromPoint\(42, 84\)/);
  assert.match(evaluated, /data-terminal-panel-id/);
  assert.match(evaluated, /data-panel-wrapper/);
  assert.match(evaluated, /terminalChatViewAvailable/);
  assert.match(evaluated, /data-terminal-session-panel-id/);
  assert.equal(await resolveTerminalPanelAtPoint(null, 42, 84), null);
});

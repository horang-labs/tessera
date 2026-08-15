import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('all product keyboard shortcuts emit static shortcut telemetry', () => {
  const globalShortcuts = source('src/hooks/use-keyboard-shortcuts.ts');
  const composerShortcuts = source('src/components/chat/composer-session-controls.tsx');
  const messageInput = source('src/components/chat/message-input.tsx');
  const memoryFile = source('src/components/memory/memory-file-tab.tsx');
  const workspaceFile = source('src/components/workspace/workspace-code-view.tsx');

  assert.match(globalShortcuts, /keyboard_shortcut_used'[\s\S]*?shortcut: id/);
  for (const shortcut of [
    'toggle-plan-mode',
    'toggle-fast-mode',
    'open-model-selector',
    'open-reasoning-selector',
  ]) {
    assert.match(composerShortcuts, new RegExp(`keyboard_shortcut_used'.*shortcut: '${shortcut}'`));
  }
  assert.match(messageInput, /keyboard_shortcut_used'.*shortcut: 'voice-input'/);
  assert.match(memoryFile, /keyboard_shortcut_used'.*shortcut: 'save-memory-file'/);
  assert.match(workspaceFile, /keyboard_shortcut_used'.*shortcut: 'save-workspace-file'/);
});

test('drag-only workspace mutations emit content-free movement telemetry', () => {
  for (const relativePath of [
    'src/hooks/use-project-strip-dnd.ts',
    'src/hooks/use-sub-session-reorder.ts',
    'src/hooks/use-collection-dnd.ts',
    'src/hooks/use-session-refs.ts',
    'src/components/tab/tab-bar.tsx',
    'src/components/board/kanban-column.tsx',
    'src/components/board/kanban-board.tsx',
    'src/components/panel/panel-wrapper.tsx',
  ]) {
    const fileSource = source(relativePath);
    assert.match(fileSource, /captureTelemetryEvent\('workspace_item_moved'/, relativePath);
    for (const call of fileSource.matchAll(/captureTelemetryEvent\('workspace_item_moved',[\s\S]*?\);/g)) {
      assert.doesNotMatch(
        call[0],
        /(?:id|path|title|name|content|prompt|message)\s*:/,
        `${relativePath} must emit only static movement categories`,
      );
    }
  }
});

test('workspace file mutations emit action outcomes without file data', () => {
  for (const relativePath of [
    'src/components/workspace/workspace-file-panel.tsx',
    'src/components/workspace/workspace-file-tab.tsx',
  ]) {
    const fileSource = source(relativePath);
    assert.match(fileSource, /captureTelemetryEvent\('workspace_file_action_result'/, relativePath);
    for (const call of fileSource.matchAll(/captureTelemetryEvent\('workspace_file_action_result',[\s\S]*?\);/g)) {
      assert.doesNotMatch(
        call[0],
        /(?:path|name|content|draft|query|error_message)\s*:/,
        `${relativePath} must emit only static file-action categories`,
      );
    }
  }

  const editor = source('src/components/workspace/workspace-file-tab.tsx');
  assert.match(editor, /captureTelemetryEvent\('workspace_file_edit_started',[\s\S]*?entry_kind: 'file'/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getWorkspaceFileDragPath,
  hasWorkspaceFileDragData,
  isSessionReferenceDragData,
  parseWorkspaceFileDragData,
  setWorkspaceFileDragData,
} from '../src/lib/dnd/panel-session-drag';
import {
  SESSION_DRAG_MIME,
  WORKSPACE_FILE_DRAG_MIME,
} from '../src/types/panel';
import { buildWorkspaceFileSessionId } from '../src/lib/workspace-tabs/special-session';
import {
  formatWorkspaceFileReference,
  insertWorkspaceFileReferenceAtCursor,
} from '../src/lib/chat/workspace-file-reference';

class FakeDataTransfer {
  effectAllowed = 'uninitialized';
  dropEffect = 'none';
  readonly data = new Map<string, string>();

  get types(): string[] {
    return Array.from(this.data.keys());
  }

  setData(type: string, value: string): void {
    this.data.set(type, value);
  }

  getData(type: string): string {
    return this.data.get(type) ?? '';
  }
}

test('workspace file drags carry both panel and composer payloads', () => {
  const transfer = new FakeDataTransfer();

  setWorkspaceFileDragData(transfer, 'source-session', 'file', 'docs/readme.md');

  assert.equal(
    transfer.getData(SESSION_DRAG_MIME),
    buildWorkspaceFileSessionId('source-session', 'file', 'docs/readme.md'),
  );
  assert.deepEqual(parseWorkspaceFileDragData(transfer), {
    sourceSessionId: 'source-session',
    kind: 'file',
    path: 'docs/readme.md',
  });
  assert.equal(transfer.getData('text/plain'), 'docs/readme.md');
  assert.equal(transfer.effectAllowed, 'copyMove');
  assert.ok(transfer.types.includes(SESSION_DRAG_MIME));
  assert.ok(transfer.types.includes(WORKSPACE_FILE_DRAG_MIME));
  assert.equal(hasWorkspaceFileDragData(transfer), true);
  assert.equal(isSessionReferenceDragData(transfer), false);
  assert.equal(getWorkspaceFileDragPath(transfer), 'docs/readme.md');
});

test('workspace file drag parser rejects malformed payloads', () => {
  for (const payload of [
    '',
    '{',
    '{}',
    JSON.stringify({ sourceSessionId: '', kind: 'file', path: 'docs/readme.md' }),
    JSON.stringify({ sourceSessionId: 'source-session', kind: 'chat', path: 'docs/readme.md' }),
    JSON.stringify({ sourceSessionId: 'source-session', kind: 'file', path: '' }),
  ]) {
    const transfer = new FakeDataTransfer();
    transfer.setData(WORKSPACE_FILE_DRAG_MIME, payload);
    assert.equal(parseWorkspaceFileDragData(transfer), null);
  }
});

test('session reference drag detection ignores workspace file pseudo-sessions only', () => {
  const sessionTransfer = new FakeDataTransfer();
  sessionTransfer.setData(SESSION_DRAG_MIME, 'real-session-id');
  assert.equal(isSessionReferenceDragData(sessionTransfer), true);
  assert.equal(hasWorkspaceFileDragData(sessionTransfer), false);

  const workspaceTransfer = new FakeDataTransfer();
  workspaceTransfer.setData(SESSION_DRAG_MIME, '__workspace-file__|pseudo');
  workspaceTransfer.setData(WORKSPACE_FILE_DRAG_MIME, JSON.stringify({
    sourceSessionId: 'source-session',
    kind: 'file',
    path: 'docs/readme.md',
  }));
  assert.equal(isSessionReferenceDragData(workspaceTransfer), false);
  assert.equal(hasWorkspaceFileDragData(workspaceTransfer), true);
});

test('workspace file path falls back to text/plain when structured payload is malformed', () => {
  const transfer = new FakeDataTransfer();
  transfer.setData(WORKSPACE_FILE_DRAG_MIME, '{');
  transfer.setData('text/plain', 'docs/readme.md');
  assert.equal(getWorkspaceFileDragPath(transfer), 'docs/readme.md');
});

test('workspace file references are inserted at the requested cursor', () => {
  assert.equal(formatWorkspaceFileReference('docs/readme.md'), '@docs/readme.md ');
  assert.deepEqual(
    insertWorkspaceFileReferenceAtCursor('look  now', 5, 'docs/readme.md'),
    {
      nextValue: 'look @docs/readme.md  now',
      nextCursorPos: 21,
    },
  );
  assert.deepEqual(
    insertWorkspaceFileReferenceAtCursor('tail', 999, 'src/app/page.tsx'),
    {
      nextValue: 'tail@src/app/page.tsx ',
      nextCursorPos: 22,
    },
  );
  assert.deepEqual(
    insertWorkspaceFileReferenceAtCursor('head', -10, 'README.md'),
    {
      nextValue: '@README.md head',
      nextCursorPos: 11,
    },
  );
});

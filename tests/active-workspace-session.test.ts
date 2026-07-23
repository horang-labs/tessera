import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveActiveWorkspaceSessionId,
  resolveVisibleWorkspaceSessionId,
} from '../src/lib/session/active-workspace-session';
import {
  buildWorkspaceExplorerSessionId,
  buildWorkspaceFileSessionId,
} from '../src/lib/workspace-tabs/special-session';

test('active workspace session prefers the active panel over stale session store state', () => {
  assert.equal(
    resolveActiveWorkspaceSessionId({
      activePanelSessionId: 'real-session',
      activeSessionId: null,
    }),
    'real-session',
  );
});

test('active workspace session resolves workspace special tabs to their source session', () => {
  assert.equal(
    resolveActiveWorkspaceSessionId({
      activePanelSessionId: buildWorkspaceFileSessionId('source-session', 'file', 'src/app/page.tsx'),
      activeSessionId: null,
    }),
    'source-session',
  );

  assert.equal(
    resolveActiveWorkspaceSessionId({
      activePanelSessionId: buildWorkspaceExplorerSessionId('explorer-source'),
      activeSessionId: null,
    }),
    'explorer-source',
  );
});

test('active workspace session falls back to active session store when panel has no chat session', () => {
  assert.equal(
    resolveActiveWorkspaceSessionId({
      activePanelSessionId: null,
      activeSessionId: 'stored-session',
    }),
    'stored-session',
  );
});

test('active workspace session ignores non-workspace special sessions', () => {
  assert.equal(
    resolveActiveWorkspaceSessionId({
      activePanelSessionId: '__skills-dashboard__',
      activeSessionId: null,
    }),
    null,
  );
});

test('full-board Peek only treats the open Peek session as visible', () => {
  assert.equal(
    resolveVisibleWorkspaceSessionId({
      activeSessionId: 'hidden-tab-session',
      isKanbanPeekLayout: true,
      peekSessionId: 'peek-session',
    }),
    'peek-session',
  );
});

test('dismissed full-board Peek does not fall back to the hidden tab session', () => {
  assert.equal(
    resolveVisibleWorkspaceSessionId({
      activeSessionId: 'hidden-tab-session',
      isKanbanPeekLayout: true,
      peekSessionId: null,
    }),
    null,
  );
});

test('split and list layouts continue using the active workspace session', () => {
  assert.equal(
    resolveVisibleWorkspaceSessionId({
      activeSessionId: 'active-session',
      isKanbanPeekLayout: false,
      peekSessionId: null,
    }),
    'active-session',
  );
});

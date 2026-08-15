import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveCanonicalGitTargetSessionId,
  resolveActiveWorkspaceSessionId,
  resolveVisibleWorkspaceSessionId,
  shouldBridgeActiveSessionToPanel,
} from '../src/lib/session/active-workspace-session';
import {
  buildWorkspaceFileSessionId,
  buildWorktreeFileSessionId,
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

test('active workspace session resolves session-backed file tabs to their source session', () => {
  assert.equal(
    resolveActiveWorkspaceSessionId({
      activePanelSessionId: buildWorkspaceFileSessionId('source-session', 'file', 'src/app/page.tsx'),
      activeSessionId: null,
    }),
    'source-session',
  );
});

test('session-backed file tabs are not reconciled back to their source chat surface', () => {
  const fileSessionId = buildWorkspaceFileSessionId(
    'source-session',
    'file',
    'src/app/page.tsx',
  );

  assert.equal(shouldBridgeActiveSessionToPanel({
    activePanelSessionId: fileSessionId,
    activePanelWorkspaceSessionId: 'source-session',
    renderedActiveSessionId: 'source-session',
    currentActiveSessionId: 'source-session',
    projectsLoaded: true,
  }), false);
});

test('a stale reverse bridge cannot undo panel navigation from the same commit', () => {
  assert.equal(shouldBridgeActiveSessionToPanel({
    activePanelSessionId: 'new-panel-session',
    activePanelWorkspaceSessionId: 'new-panel-session',
    renderedActiveSessionId: 'previous-session',
    currentActiveSessionId: 'new-panel-session',
    projectsLoaded: true,
  }), false);

  assert.equal(shouldBridgeActiveSessionToPanel({
    activePanelSessionId: 'new-panel-session',
    activePanelWorkspaceSessionId: 'new-panel-session',
    renderedActiveSessionId: 'new-panel-session',
    currentActiveSessionId: 'new-panel-session',
    projectsLoaded: true,
  }), true);
});

test('sessionless Worktree file tabs do not invent a canonical Session source', () => {
  assert.equal(
    resolveActiveWorkspaceSessionId({
      activePanelSessionId: buildWorktreeFileSessionId('worktree-source', 'src/app/page.tsx'),
      activeSessionId: null,
    }),
    null,
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

test('Git drops optimistic sessions and any Session target hidden by Worktree Peek', () => {
  assert.equal(
    resolveCanonicalGitTargetSessionId({
      activeSessionId: 'real-session',
      peekWorktreeId: 'worktree-1',
    }),
    null,
  );
  assert.equal(
    resolveCanonicalGitTargetSessionId({
      activeSessionId: 'temp-optimistic',
      peekWorktreeId: null,
    }),
    null,
  );
  assert.equal(
    resolveCanonicalGitTargetSessionId({
      activeSessionId: 'real-session',
      peekWorktreeId: null,
    }),
    'real-session',
  );
});

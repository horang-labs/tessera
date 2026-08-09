import assert from 'node:assert/strict';
import test from 'node:test';
import { usePanelStore } from '@/stores/panel-store';
import { useSessionStore } from '@/stores/session-store';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';

const scopedSession: UnifiedSession = {
  id: 'open-main-session',
  title: 'Still sendable',
  projectDir: 'project-view',
  workDir: '/repository',
  worktreeId: 'wt_root',
  scopeBranch: 'main',
  provider: 'codex',
  kind: 'chat',
  status: 'completed',
  isRunning: false,
  hasStarted: true,
  createdAt: '2026-08-09T00:00:00.000Z',
  lastModified: '2026-08-09T00:00:00.000Z',
};

function project(sessions: UnifiedSession[], branch: string): ProjectGroup {
  return {
    encodedDir: 'project-view',
    displayName: 'Project View',
    decodedPath: '/repository',
    isCurrent: true,
    projectWorktree: {
      id: 'wt_root',
      path: '/repository',
      displayPath: '/repository',
      currentBranch: branch,
    },
    sessions,
    totalSessions: sessions.length,
    allLoaded: true,
    loadedCount: sessions.length,
    nextCursor: null,
    loadBatchIndex: 0,
  };
}

test('a branch refresh hides a Session from projection but retains an open tab target', async (t) => {
  useSessionStore.setState({
    ...useSessionStore.getInitialState(),
    projects: [project([scopedSession], 'main')],
  });
  usePanelStore.setState({
    activeTabId: 'project-tab',
    tabPanels: {
      'project-tab': {
        layout: { type: 'leaf', panelId: 'chat-panel' },
        activePanelId: 'chat-panel',
        panels: {
          'chat-panel': { id: 'chat-panel', sessionId: scopedSession.id },
        },
      },
    },
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    projects: [{
      ...project([], 'feature/external-switch'),
      countByStatus: {},
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));

  await useSessionStore.getState().loadProjects();

  assert.deepEqual(useSessionStore.getState().projects[0].sessions, []);
  assert.equal(useSessionStore.getState().getSession(scopedSession.id)?.title, 'Still sendable');
  assert.equal(useSessionStore.getState().getSession(scopedSession.id)?.isReadOnly, undefined);

  useSessionStore.getState().updateSessionTitle(scopedSession.id, 'Renamed while hidden');
  useSessionStore.getState().markSessionRunning(scopedSession.id, scopedSession.id);
  useSessionStore.getState().incrementUnreadCount(scopedSession.id);
  useSessionStore.getState().applyDiffStatsUpdate([scopedSession.id], {
    added: 2,
    removed: 1,
    changedFiles: 1,
    newFiles: 0,
    deletedFiles: 0,
    computedAt: '2026-08-09T01:00:00.000Z',
  });
  const updated = useSessionStore.getState().getSession(scopedSession.id);
  assert.equal(updated?.title, 'Renamed while hidden');
  assert.equal(updated?.isRunning, true);
  assert.equal(updated?.status, 'running');
  assert.equal(updated?.unreadCount, 1);
  assert.deepEqual(updated?.diffStats, {
    added: 2,
    removed: 1,
    changedFiles: 1,
    newFiles: 0,
    deletedFiles: 0,
    computedAt: '2026-08-09T01:00:00.000Z',
  });
});

test('a changed Worktree branch schedules a Project projection refresh', async () => {
  useSessionStore.setState({
    ...useSessionStore.getInitialState(),
    projects: [project([], 'main')],
  });
  let refreshes = 0;
  useSessionStore.setState({ loadProjects: async () => { refreshes += 1; } });

  useSessionStore.getState().updateProjectWorktreeBranch('wt_root', 'feature/external-switch');
  await Promise.resolve();

  assert.equal(refreshes, 1);
  assert.equal(
    useSessionStore.getState().projects[0].projectWorktree?.currentBranch,
    'feature/external-switch',
  );
});

test('canonical Session state changes stay consistent across independent Project views', () => {
  const sessionInA = {
    ...scopedSession,
    projectDir: 'project-a',
    originProjectId: 'project-a',
  };
  const sessionInC = { ...sessionInA, projectDir: 'project-c' };
  useSessionStore.setState({
    ...useSessionStore.getInitialState(),
    projects: [
      { ...project([sessionInA], 'main'), encodedDir: 'project-a' },
      { ...project([sessionInC], 'main'), encodedDir: 'project-c' },
    ],
  });

  useSessionStore.getState().updateSessionTitle(sessionInA.id, 'One canonical title');
  useSessionStore.getState().incrementUnreadCount(sessionInA.id);
  useSessionStore.getState().markSessionRunning(sessionInA.id, sessionInA.id);

  const appearances = useSessionStore.getState().projects.map((item) => item.sessions[0]);
  assert.deepEqual(
    appearances.map((session) => ({
      id: session.id,
      originProjectId: session.originProjectId,
      title: session.title,
      unreadCount: session.unreadCount,
      isRunning: session.isRunning,
    })),
    [
      {
        id: sessionInA.id,
        originProjectId: 'project-a',
        title: 'One canonical title',
        unreadCount: 1,
        isRunning: true,
      },
      {
        id: sessionInA.id,
        originProjectId: 'project-a',
        title: 'One canonical title',
        unreadCount: 1,
        isRunning: true,
      },
    ],
  );

  useSessionStore.getState().removeProject('project-c');
  assert.equal(useSessionStore.getState().projects[0].sessions[0].title, 'One canonical title');
});

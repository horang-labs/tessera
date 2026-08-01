import assert from 'node:assert/strict';
import test from 'node:test';
import { useSessionStore } from '@/stores/session-store';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';

function session(id: string, projectDir: string): UnifiedSession {
  return {
    id,
    title: id,
    projectDir,
    isRunning: false,
    status: 'completed',
    lastModified: '2026-08-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    archived: false,
    sortOrder: 0,
  };
}

function project(encodedDir: string, sessions: UnifiedSession[]): ProjectGroup {
  return {
    encodedDir,
    displayName: encodedDir,
    decodedPath: `/workspace/${encodedDir}`,
    isCurrent: false,
    sessions,
    totalSessions: sessions.length,
    allLoaded: true,
    loadedCount: sessions.length,
    nextCursor: null,
    loadBatchIndex: 0,
  };
}

test('the last conversation project survives activation of an empty New Tab', (t) => {
  const previousState = useSessionStore.getState();
  t.after(() => useSessionStore.setState(previousState));

  useSessionStore.setState({
    projects: [
      project('project-a', [session('session-a', 'project-a')]),
      project('project-b', [session('session-b', 'project-b')]),
    ],
    activeSessionId: null,
    lastActiveProjectDir: null,
  });

  useSessionStore.getState().setActiveSession('session-b');
  useSessionStore.getState().setActiveSession(null);

  assert.equal(useSessionStore.getState().activeSessionId, null);
  assert.equal(useSessionStore.getState().lastActiveProjectDir, 'project-b');
});

test('background session additions do not replace the last conversation project', (t) => {
  const previousState = useSessionStore.getState();
  t.after(() => useSessionStore.setState(previousState));

  useSessionStore.setState({
    projects: [project('project-a', [session('session-a', 'project-a')])],
    activeSessionId: 'session-a',
    lastActiveProjectDir: 'project-a',
  });

  useSessionStore.getState().addSession(
    session('background-session', 'project-b'),
    { activate: false },
  );

  assert.equal(useSessionStore.getState().lastActiveProjectDir, 'project-a');
});

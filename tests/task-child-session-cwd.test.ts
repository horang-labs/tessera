import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';
import { buildTaskChildSession } from '@/lib/session/task-child-session';
import { getInitialTerminalCwd } from '@/lib/terminal/client-terminal-cwd';
import { useBoardStore } from '@/stores/board-store';
import { useSessionStore } from '@/stores/session-store';
import type { ProjectGroup } from '@/types/chat';
import type { TaskEntity } from '@/types/task-entity';

const collectionGroupSource = fs.readFileSync(
  new URL('../src/components/chat/collection-group.tsx', import.meta.url),
  'utf8',
);
const kanbanBoardSource = fs.readFileSync(
  new URL('../src/components/board/kanban-board.tsx', import.meta.url),
  'utf8',
);

function project(encodedDir: string, decodedPath: string): ProjectGroup {
  return {
    encodedDir,
    decodedPath,
    displayName: encodedDir,
    isCurrent: false,
    sessions: [],
    totalSessions: 0,
    allLoaded: true,
    loadedCount: 0,
    nextCursor: null,
    loadBatchIndex: 0,
  };
}

function worktreeTask(workDir: string): TaskEntity {
  return {
    id: 'task-mobile',
    projectId: 'tessera-project',
    projectViewId: 'tessera-project',
    title: 'Mobile feature',
    workflowStatus: 'todo',
    worktreeBranch: 'feature/mobile',
    workDir,
    sortOrder: 0,
    sessions: [],
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  };
}

test.afterEach(() => {
  useSessionStore.setState({ projects: [], activeSessionId: null });
  useBoardStore.setState({ selectedProjectDir: ALL_PROJECTS_SENTINEL });
});

test('a newly added task child launches in its worktree before project reload finishes', () => {
  const unrelatedProject = '/home/work/Source/content-lab';
  const worktreePath = '/home/work/Source/tessera-dev--mobile';
  const task = worktreeTask(worktreePath);
  const session = buildTaskChildSession(task, {
    sessionId: 'session-mobile-2',
    title: 'Session 2',
    status: 'starting',
    provider: 'codex',
    kind: 'terminal',
  }, '2026-08-03T00:00:01.000Z');

  useSessionStore.setState({
    projects: [
      project(unrelatedProject, unrelatedProject),
      project(task.projectId, '/home/work/Source/tessera-dev'),
    ],
  });
  useBoardStore.setState({ selectedProjectDir: ALL_PROJECTS_SENTINEL });
  useSessionStore.getState().addSession(session);

  assert.equal(session.workDir, worktreePath);
  assert.equal(getInitialTerminalCwd(session.id), worktreePath);
});

test('a session-bound terminal never borrows an unrelated explicit or selected project cwd', () => {
  const unrelatedProject = '/home/work/Source/content-lab';
  useSessionStore.setState({
    projects: [
      project(unrelatedProject, unrelatedProject),
      project('tessera-project', '/home/work/Source/tessera-dev'),
    ],
  });
  useBoardStore.setState({ selectedProjectDir: unrelatedProject });
  useSessionStore.getState().addSession({
    id: 'session-without-workspace',
    projectDir: 'tessera-project',
    originProjectId: 'tessera-project',
    title: 'Missing workspace',
    status: 'starting',
    provider: 'codex',
    kind: 'terminal',
    createdAt: '2026-08-03T00:00:01.000Z',
    messages: [],
  });

  assert.equal(
    getInitialTerminalCwd('session-without-workspace', unrelatedProject),
    null,
  );
});

test('a standalone terminal without an explicit cwd does not select the first project', () => {
  useSessionStore.setState({
    projects: [project('project-a', '/home/work/Source/content-lab')],
  });

  assert.equal(getInitialTerminalCwd(null, null), null);
});

test('list and board task-child creation use the shared cwd-preserving mapper', () => {
  assert.match(collectionGroupSource, /buildTaskChildSession\(task, sessionData\)/);
  assert.match(kanbanBoardSource, /buildTaskChildSession\(task, data\)/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { useSessionStore } from '@/stores/session-store';

const stored = new Map<string, string>();
const localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value); },
  removeItem: (key: string) => { stored.delete(key); },
};

function apiProject(previousBranch: string, currentBranch: string) {
  return {
    encodedDir: '/repo',
    displayName: 'Repo',
    decodedPath: '/repo',
    isCurrent: true,
    projectWorktree: {
      id: 'wt_root',
      path: '/repo',
      displayPath: '/repo',
      currentBranch,
    },
    branchRenameWarning: { previousBranch, currentBranch },
    sessions: [],
    totalSessions: 0,
    countByStatus: {},
    cursorByStatus: {},
    nextCursor: null,
  };
}

test('dismissal hides only the same one-time branch rename warning across reloads', async (t) => {
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage },
    configurable: true,
  });
  t.after(() => {
    delete (globalThis as { window?: unknown }).window;
    stored.clear();
  });
  let responseProject = apiProject('main', 'renamed');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    projects: [responseProject],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  useSessionStore.setState(useSessionStore.getInitialState());

  await useSessionStore.getState().loadProjects();
  assert.deepEqual(useSessionStore.getState().projects[0].branchRenameWarning, {
    previousBranch: 'main',
    currentBranch: 'renamed',
  });

  useSessionStore.getState().dismissBranchRenameWarning('/repo');
  assert.equal(useSessionStore.getState().projects[0].branchRenameWarning, undefined);
  await useSessionStore.getState().loadProjects();
  assert.equal(useSessionStore.getState().projects[0].branchRenameWarning, undefined);

  responseProject = apiProject('renamed', 'renamed-again');
  await useSessionStore.getState().loadProjects();
  assert.deepEqual(useSessionStore.getState().projects[0].branchRenameWarning, {
    previousBranch: 'renamed',
    currentBranch: 'renamed-again',
  });
});

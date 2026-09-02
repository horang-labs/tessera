import assert from 'node:assert/strict';
import test from 'node:test';

import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';

test('Project View branch selection only requests filtered projections', async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    return new Response(JSON.stringify(url.startsWith('/api/tasks') ? { tasks: [] } : { projects: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  useSessionStore.setState({
    ...useSessionStore.getInitialState(),
    projectCreationBranchFilters: {},
  });
  useTaskStore.setState(useTaskStore.getInitialState());

  useSessionStore.getState().setProjectCreationBranchFilter('project-a', 'historical/deleted');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(useSessionStore.getState().projectCreationBranchFilters['project-a'], 'historical/deleted');
  assert.ok(requests.some((url) => url.includes('/api/sessions/projects?creationBranchFilters=')));
  assert.ok(requests.some((url) => url.includes(
    '/api/tasks?projectId=project-a&creationBranch=historical%2Fdeleted',
  )));
  assert.ok(requests.every((url) => !url.includes('/api/git/') && !url.includes('checkout')));
});

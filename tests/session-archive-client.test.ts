import assert from 'node:assert/strict';
import test from 'node:test';

import { requestSessionArchive } from '@/lib/session/session-archive-client';
import { useSessionStore } from '@/stores/session-store';

test('Session-level archive entry points preserve the canonical Session identity', (t) => {
  const requested: Array<[sessionId: string, archived: boolean]> = [];
  const originalToggleArchive = useSessionStore.getState().toggleArchive;
  useSessionStore.setState({
    toggleArchive: (sessionId, archived) => {
      requested.push([sessionId, archived]);
    },
  });
  t.after(() => {
    useSessionStore.setState({ toggleArchive: originalToggleArchive });
  });

  requestSessionArchive('task-owned-session');

  assert.deepEqual(requested, [['task-owned-session', true]]);
});

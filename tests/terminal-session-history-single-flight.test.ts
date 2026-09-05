import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CliProvider } from '@/lib/cli/providers/types';
import type { SessionRow } from '@/lib/db/sessions';
import type { SessionHistoryEvent } from '@/lib/session-replay-types';

process.env.TESSERA_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'tessera-history-single-flight-'));
process.env.NODE_ENV = 'test';

function terminalSession(id: string): SessionRow {
  const timestamp = new Date().toISOString();
  return {
    id,
    project_id: 'project',
    title: 'Session',
    has_custom_title: 0,
    provider: 'codex',
    provider_state: JSON.stringify({ kind: 'terminal', codexSessionId: `provider-${id}` }),
    model: null,
    reasoning_effort: null,
    service_tier: null,
    work_dir: null,
    worktree_branch: null,
    worktree_id: null,
    scope_branch: null,
    archived: 0,
    archived_at: null,
    worktree_deleted_at: null,
    deleted: 0,
    task_id: null,
    chat_workflow_status: null,
    collection_id: null,
    sort_order: 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

test('concurrent requests share one terminal transcript decode', async () => {
  const { initDatabase } = await import('@/lib/db/database');
  const { cliProviderRegistry } = await import('@/lib/cli/providers/registry');
  const { readTerminalSessionReplayState } = await import('@/lib/session/terminal-session-history');
  await initDatabase();

  let decodeCount = 0;
  let releaseDecode!: () => void;
  const decodeGate = new Promise<void>((resolve) => {
    releaseDecode = resolve;
  });
  const events: SessionHistoryEvent[] = [{
    v: 1,
    type: 'assistant_message',
    timestamp: '2026-09-04T00:00:00.000Z',
    content: 'done',
  }];
  const provider = {
    readTerminalTranscriptFingerprint: async () => 'same-transcript',
    readTerminalTranscriptEvents: async () => {
      decodeCount += 1;
      await decodeGate;
      return events;
    },
  } as unknown as CliProvider;
  cliProviderRegistry.register('codex', provider);

  const session = terminalSession(`single-flight-${Date.now()}`);
  const first = readTerminalSessionReplayState(session, 'user');
  const second = readTerminalSessionReplayState(session, 'user');
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(decodeCount, 1);
  releaseDecode();
  const [firstState, secondState] = await Promise.all([first, second]);
  assert.strictEqual(firstState, secondState);
  assert.equal(firstState?.messages.length, 1);
});

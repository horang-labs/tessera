import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGitConflictResolutionRequest,
  deriveGitConflictHandoffAvailability,
  revalidateGitConflictHandoff,
} from '@/lib/git/git-conflict-handoff';
import { useChatStore } from '@/stores/chat-store';
import type { UnifiedSession } from '@/types/chat';
import type { GitPanelData } from '@/types/git';

const PANEL = {
  sessionId: 'session-1',
  worktreePath: '/repo/worktree',
  conflictOperation: 'rebase',
  changedFiles: [
    { path: 'src/unresolved.ts', state: 'conflicted' },
    { path: 'notes.txt', state: 'modified' },
    { path: 'src/also-unresolved.ts', state: 'conflicted' },
  ],
} as GitPanelData;

const SESSION = {
  id: 'session-1',
  provider: 'codex',
  kind: 'chat',
  archived: false,
  isReadOnly: false,
} as UnifiedSession;

test('Resolve with AI is available only for a complete conflict list and compatible chat session', () => {
  assert.equal(deriveGitConflictHandoffAvailability(PANEL, SESSION, 'connected'), true);
  assert.equal(deriveGitConflictHandoffAvailability(PANEL, { ...SESSION, kind: 'terminal' }, 'connected'), false);
  assert.equal(deriveGitConflictHandoffAvailability(PANEL, { ...SESSION, isReadOnly: true }, 'connected'), false);
  assert.equal(deriveGitConflictHandoffAvailability(PANEL, { ...SESSION, provider: undefined }, 'connected'), false);
  assert.equal(deriveGitConflictHandoffAvailability(PANEL, { ...SESSION, status: 'error' }, 'connected'), false);
  assert.equal(deriveGitConflictHandoffAvailability(PANEL, SESSION, 'disconnected'), false);
  assert.equal(deriveGitConflictHandoffAvailability({ ...PANEL, changedFilesTruncated: true }, SESSION, 'connected'), false);
  assert.equal(
    deriveGitConflictHandoffAvailability({ ...PANEL, changedFiles: PANEL.changedFiles.filter((file) => file.state !== 'conflicted') }, SESSION, 'connected'),
    false,
  );
});

test('Resolve with AI is unavailable when the complete path list cannot fit in the composer', () => {
  const manyConflicts = {
    ...PANEL,
    changedFiles: Array.from({ length: 400 }, (_, index) => ({
      path: `src/${String(index).padStart(3, '0')}-${'long-name-'.repeat(4)}.ts`,
      state: 'conflicted',
    })),
  } as GitPanelData;

  assert.ok(buildGitConflictResolutionRequest(manyConflicts).length > 10_000);
  assert.equal(deriveGitConflictHandoffAvailability(manyConflicts, SESSION, 'connected'), false);
});

test('the prepared request identifies the worktree, live operation, and unresolved relative paths only', () => {
  const request = buildGitConflictResolutionRequest(PANEL);

  assert.match(request, /Worktree: "\/repo\/worktree"/);
  assert.match(request, /Operation: rebase/);
  assert.match(request, /"src\/unresolved\.ts"/);
  assert.match(request, /"src\/also-unresolved\.ts"/);
  assert.doesNotMatch(request, /notes\.txt/);
  assert.doesNotMatch(request, /file contents|<<<<<<<|=======|>>>>>>>/);
  assert.match(request, /Do not continue the rebase or commit/);
});

test('handoff revalidates the live conflict state and rejects a changed path set as stale', async () => {
  const result = await revalidateGitConflictHandoff(PANEL, SESSION, 'connected', async () => ({
    kind: 'loaded',
    data: {
      ...PANEL,
      changedFiles: [{ path: 'src/new-conflict.ts', state: 'conflicted' }],
    } as GitPanelData,
  }));

  assert.equal(result.kind, 'stale');
  assert.deepEqual(result.data.changedFiles.map((file) => file.path), ['src/new-conflict.ts']);
});

test('a current handoff prepares an editable draft without submitting a message', async () => {
  const result = await revalidateGitConflictHandoff(PANEL, SESSION, 'connected', async () => ({
    kind: 'loaded',
    data: PANEL,
  }));
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') return;

  useChatStore.setState({ messages: new Map(), draftInputs: new Map() });
  const messagesBefore = useChatStore.getState().messages;
  useChatStore.getState().prepareAgentRequest('session-1', result.request);

  assert.equal(useChatStore.getState().getDraftInput('session-1'), result.request);
  assert.equal(useChatStore.getState().messages, messagesBefore);
  assert.equal(useChatStore.getState().messages.has('session-1'), false);
});

test('handoff reports an unavailable session and preserves manual recovery', async () => {
  const result = await revalidateGitConflictHandoff(
    PANEL,
    { ...SESSION, archived: true },
    'connected',
    async () => ({ kind: 'loaded', data: PANEL }),
  );

  assert.equal(result.kind, 'unavailable');
});

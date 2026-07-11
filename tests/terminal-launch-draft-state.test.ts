import assert from 'node:assert/strict';
import test from 'node:test';
import {
  consumeTerminalLaunchDraft,
  isTerminalLaunchDraftCurrent,
  recordTerminalDraftEdit,
  registerTerminalLaunchDraft,
  shouldClearTerminalLaunchDraft,
} from '../src/lib/terminal/terminal-launch-draft-state';

test('terminal launch clears only the exact draft revision captured at launch', () => {
  const sessionId = 'draft-session';
  registerTerminalLaunchDraft('draft-terminal-1', sessionId, '/th');
  const unchanged = consumeTerminalLaunchDraft('draft-terminal-1');
  assert.ok(unchanged);
  assert.equal(unchanged.draftAtLaunch, '/th');
  assert.equal(isTerminalLaunchDraftCurrent(unchanged), true);

  registerTerminalLaunchDraft('draft-terminal-2', sessionId, '/theme');
  recordTerminalDraftEdit(sessionId);
  const retyped = consumeTerminalLaunchDraft('draft-terminal-2');
  assert.ok(retyped);
  assert.equal(isTerminalLaunchDraftCurrent(retyped), false);
});

test('programmatic attachment insertion invalidates an older ACK even when persisted draft text is unchanged', () => {
  const sessionId = 'programmatic-draft-session';

  registerTerminalLaunchDraft('unchanged-terminal', sessionId, '/theme');
  const unchanged = consumeTerminalLaunchDraft('unchanged-terminal');
  assert.ok(unchanged);
  assert.equal(shouldClearTerminalLaunchDraft(unchanged, '/theme'), true);

  registerTerminalLaunchDraft('attachment-terminal', sessionId, '/theme');
  // Async attachment/reference completion updates local composer state before
  // its persisted draft catches up. The synchronous revision is the guard.
  recordTerminalDraftEdit(sessionId);
  const afterAttachmentInsert = consumeTerminalLaunchDraft('attachment-terminal');
  assert.ok(afterAttachmentInsert);
  assert.equal(shouldClearTerminalLaunchDraft(afterAttachmentInsert, '/theme'), false);
});

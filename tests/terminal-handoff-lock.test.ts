import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireTerminalHandoffLock,
  assertSessionNotHandedOffToTerminal,
  beginTesseraSessionOperation,
  beginTesseraSessionOperations,
  beginExclusiveTesseraSessionOperation,
  endExclusiveTesseraSessionOperation,
  endTesseraSessionOperation,
  isSessionHandedOffToTerminal,
  isTerminalHandoffConflictError,
  ownsTerminalHandoffLock,
  releaseTerminalHandoffByTerminal,
  releaseTerminalHandoffsForUser,
  TerminalHandoffConflictError,
  withTesseraSessionOperation,
  withExclusiveTesseraSessionOperation,
} from '../src/lib/terminal/terminal-handoff-lock';

test('handoff lock is a bijection between one session and one terminal', () => {
  const userId = 'lock-user-1';
  const terminalId = 'lock-terminal-1';
  const firstSessionId = 'lock-session-1';
  const secondSessionId = 'lock-session-2';

  assert.equal(acquireTerminalHandoffLock({
    sessionId: firstSessionId,
    terminalId,
    userId,
  }), true);
  assert.equal(acquireTerminalHandoffLock({
    sessionId: secondSessionId,
    terminalId,
    userId,
  }), false);
  assert.equal(acquireTerminalHandoffLock({
    sessionId: firstSessionId,
    terminalId,
    userId,
  }), false);
  assert.equal(ownsTerminalHandoffLock(firstSessionId, userId, terminalId), true);
  assert.equal(isSessionHandedOffToTerminal(secondSessionId), false);

  releaseTerminalHandoffByTerminal(userId, terminalId);
  assert.equal(isSessionHandedOffToTerminal(firstSessionId), false);
});

test('Tessera session operations and terminal handoff exclude one another', () => {
  const sessionId = 'operation-session-1';
  const userId = 'operation-user-1';
  const terminalId = 'operation-terminal-1';

  assert.equal(beginTesseraSessionOperation(sessionId), true);
  assert.equal(acquireTerminalHandoffLock({ sessionId, terminalId, userId }), false);
  endTesseraSessionOperation(sessionId);

  assert.equal(acquireTerminalHandoffLock({ sessionId, terminalId, userId }), true);
  assert.equal(beginTesseraSessionOperation(sessionId), false);
  assert.throws(
    () => assertSessionNotHandedOffToTerminal(sessionId),
    TerminalHandoffConflictError,
  );
  releaseTerminalHandoffByTerminal(userId, terminalId);

  assert.doesNotThrow(() => assertSessionNotHandedOffToTerminal(sessionId));
  assert.equal(beginTesseraSessionOperation(sessionId), true);
  endTesseraSessionOperation(sessionId);
});

test('an async Tessera operation keeps handoff excluded until it settles', async () => {
  const sessionId = 'async-operation-session-1';
  const userId = 'async-operation-user-1';
  const terminalId = 'async-operation-terminal-1';
  let finishOperation!: () => void;
  const operationBarrier = new Promise<void>((resolve) => {
    finishOperation = resolve;
  });

  const operation = withTesseraSessionOperation(sessionId, async () => {
    await operationBarrier;
    return 'done';
  });

  assert.equal(acquireTerminalHandoffLock({ sessionId, terminalId, userId }), false);
  finishOperation();
  assert.equal(await operation, 'done');
  assert.equal(acquireTerminalHandoffLock({ sessionId, terminalId, userId }), true);
  releaseTerminalHandoffByTerminal(userId, terminalId);
});

test('exclusive lifecycle operations reject concurrent sends, mutations, and handoffs', async () => {
  const sessionId = 'exclusive-operation-session-1';
  const userId = 'exclusive-operation-user-1';
  const terminalId = 'exclusive-operation-terminal-1';
  let finishOperation!: () => void;
  const barrier = new Promise<void>((resolve) => {
    finishOperation = resolve;
  });

  const operation = withExclusiveTesseraSessionOperation(sessionId, async () => {
    await barrier;
  });
  assert.equal(beginTesseraSessionOperation(sessionId), false);
  assert.equal(beginExclusiveTesseraSessionOperation(sessionId), false);
  assert.equal(acquireTerminalHandoffLock({ sessionId, terminalId, userId }), false);

  finishOperation();
  await operation;
  assert.equal(beginExclusiveTesseraSessionOperation(sessionId), true);
  endExclusiveTesseraSessionOperation(sessionId);
});

test('multi-session Tessera acquisition rolls back when one session is handed off', () => {
  const availableSessionId = 'multi-operation-session-1';
  const lockedSessionId = 'multi-operation-session-2';
  const userId = 'multi-operation-user-1';
  const terminalId = 'multi-operation-terminal-1';

  assert.equal(acquireTerminalHandoffLock({
    sessionId: lockedSessionId,
    terminalId,
    userId,
  }), true);
  assert.equal(beginTesseraSessionOperations([availableSessionId, lockedSessionId]), null);

  // A terminal can claim the first session, proving its partial operation claim
  // was rolled back instead of leaking when the second claim failed.
  assert.equal(acquireTerminalHandoffLock({
    sessionId: availableSessionId,
    terminalId: `${terminalId}-available`,
    userId,
  }), true);

  releaseTerminalHandoffByTerminal(userId, terminalId);
  releaseTerminalHandoffByTerminal(userId, `${terminalId}-available`);
});

test('handoff conflicts are recognized across compiled module boundaries by code', () => {
  const rehydratedError = Object.assign(new Error('conflict'), {
    code: 'session_handed_off_to_terminal',
  });
  assert.equal(isTerminalHandoffConflictError(rehydratedError), true);
  assert.equal(isTerminalHandoffConflictError(new Error('other')), false);
});

test('disconnect cleanup releases all pending handoffs for a user only', () => {
  const firstUser = 'disconnect-user-1';
  const secondUser = 'disconnect-user-2';
  assert.equal(acquireTerminalHandoffLock({
    sessionId: 'disconnect-session-1',
    terminalId: 'disconnect-terminal-1',
    userId: firstUser,
  }), true);
  assert.equal(acquireTerminalHandoffLock({
    sessionId: 'disconnect-session-2',
    terminalId: 'disconnect-terminal-2',
    userId: secondUser,
  }), true);

  releaseTerminalHandoffsForUser(firstUser);
  assert.equal(isSessionHandedOffToTerminal('disconnect-session-1'), false);
  assert.equal(isSessionHandedOffToTerminal('disconnect-session-2'), true);

  releaseTerminalHandoffsForUser(secondUser);
});

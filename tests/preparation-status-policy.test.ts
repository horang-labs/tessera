import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PREPARATION_PHASES,
  PREPARATION_STATUSES,
  applyPreparationEvent,
  blocksAgentStartup,
  canRerunPreparation,
  readPreparationPhase,
  readPreparationStatus,
  resolvePreparationBadge,
  resolveStageCompletion,
} from '@/lib/projects/preparation-status-policy';

test('preparation starts from every status except one already running', () => {
  for (const status of ['never_run', 'succeeded', 'failed'] as const) {
    assert.deepEqual(
      applyPreparationEvent(status, { kind: 'start' }),
      { accepted: true, status: 'running' },
    );
  }

  assert.deepEqual(
    applyPreparationEvent('running', { kind: 'start' }),
    { accepted: false, status: 'running' },
  );
});

test('a run that finishes reports its outcome from its exit code', () => {
  assert.deepEqual(
    applyPreparationEvent('running', { kind: 'finish', exitCode: 0 }),
    { accepted: true, status: 'succeeded' },
  );
  assert.deepEqual(
    applyPreparationEvent('running', { kind: 'finish', exitCode: 1 }),
    { accepted: true, status: 'failed' },
  );
  assert.deepEqual(
    applyPreparationEvent('running', { kind: 'finish', exitCode: 130 }),
    { accepted: true, status: 'failed' },
  );
});

test('a failure is cleared only by a re-run that completes successfully', () => {
  // A stray completion — a previous run reporting late — must not clear it.
  assert.deepEqual(
    applyPreparationEvent('failed', { kind: 'finish', exitCode: 0 }),
    { accepted: false, status: 'failed' },
  );

  const started = applyPreparationEvent('failed', { kind: 'start' });
  assert.deepEqual(started, { accepted: true, status: 'running' });
  assert.deepEqual(
    applyPreparationEvent(started.status, { kind: 'finish', exitCode: 0 }),
    { accepted: true, status: 'succeeded' },
  );
});

test('a completion is ignored unless a run is in flight', () => {
  for (const status of ['never_run', 'succeeded', 'failed'] as const) {
    for (const exitCode of [0, 1]) {
      assert.deepEqual(
        applyPreparationEvent(status, { kind: 'finish', exitCode }),
        { accepted: false, status },
      );
    }
  }
});

test('an interrupted run is a failure, and nothing else is touched', () => {
  // The app went away mid-run: the outcome is unknown, and an unknown outcome
  // in a half-prepared worktree is the case the user has to be told about.
  assert.deepEqual(
    applyPreparationEvent('running', { kind: 'interrupt' }),
    { accepted: true, status: 'failed' },
  );

  for (const status of ['never_run', 'succeeded', 'failed'] as const) {
    assert.deepEqual(
      applyPreparationEvent(status, { kind: 'interrupt' }),
      { accepted: false, status },
    );
  }
});

test('every terminal status allows a re-run, and only a live run blocks one', () => {
  assert.equal(canRerunPreparation('never_run'), true);
  assert.equal(canRerunPreparation('succeeded'), true);
  assert.equal(canRerunPreparation('failed'), true);
  assert.equal(canRerunPreparation('running'), false);
});

test('the badge shows work in flight and failure, and nothing else', () => {
  assert.equal(resolvePreparationBadge('running'), 'running');
  assert.equal(resolvePreparationBadge('failed'), 'failed');
  assert.equal(resolvePreparationBadge('succeeded'), null);
  assert.equal(resolvePreparationBadge('never_run'), null);
});

test('every status is covered by both the badge and the re-run rules', () => {
  assert.deepEqual(
    [...PREPARATION_STATUSES].sort(),
    ['failed', 'never_run', 'running', 'succeeded'],
  );

  for (const status of PREPARATION_STATUSES) {
    assert.equal(typeof canRerunPreparation(status), 'boolean');
    const badge = resolvePreparationBadge(status);
    assert.ok(badge === null || badge === 'running' || badge === 'failed');
  }
});

test('a before stage that succeeded hands over to after, and the run carries on', () => {
  assert.deepEqual(
    resolveStageCompletion({ phase: 'before', exitCode: 0, hasAfterScript: true }),
    { status: 'running', nextPhase: 'after' },
  );
});

test('with nothing to run afterwards, a before stage that succeeded ends the run', () => {
  assert.deepEqual(
    resolveStageCompletion({ phase: 'before', exitCode: 0, hasAfterScript: false }),
    { status: 'succeeded', nextPhase: null },
  );
});

test('a before stage that failed ends the run there, rather than installing on top of it', () => {
  assert.deepEqual(
    resolveStageCompletion({ phase: 'before', exitCode: 1, hasAfterScript: true }),
    { status: 'failed', nextPhase: null },
  );
});

test('the after stage ends the run whichever way it goes', () => {
  assert.deepEqual(
    resolveStageCompletion({ phase: 'after', exitCode: 0, hasAfterScript: true }),
    { status: 'succeeded', nextPhase: null },
  );
  assert.deepEqual(
    resolveStageCompletion({ phase: 'after', exitCode: 2, hasAfterScript: true }),
    { status: 'failed', nextPhase: null },
  );
});

test('an agent waits for a before stage in flight, and for nothing else', () => {
  assert.equal(blocksAgentStartup('running', 'before'), true);

  // The agent is released the moment `before` is done, so the `after` stage
  // still running is not something to wait for.
  assert.equal(blocksAgentStartup('running', 'after'), false);

  // A failed `before` releases it too: a prompt that silently does nothing is
  // worse than one answered by an agent whose worktree is short a file.
  for (const status of ['never_run', 'succeeded', 'failed'] as const) {
    for (const phase of PREPARATION_PHASES) {
      assert.equal(blocksAgentStartup(status, phase), false);
    }
  }
});

test('a run recorded before the split reads as the before stage', () => {
  // Those runs ran the whole script, and the whole script is now what `before`
  // holds — so the agent-startup rules read them the way they behaved.
  assert.equal(readPreparationPhase(null), 'before');
  assert.equal(readPreparationPhase(undefined), 'before');
  assert.equal(readPreparationPhase(''), 'before');
  assert.equal(readPreparationPhase('nonsense'), 'before');

  for (const phase of PREPARATION_PHASES) {
    assert.equal(readPreparationPhase(phase), phase);
  }
});

test('an unrecognised stored status is read as never run', () => {
  // The status arrives from a column that rows written before this feature
  // existed never filled in.
  assert.equal(readPreparationStatus(null), 'never_run');
  assert.equal(readPreparationStatus(undefined), 'never_run');
  assert.equal(readPreparationStatus(''), 'never_run');
  assert.equal(readPreparationStatus('nonsense'), 'never_run');

  for (const status of PREPARATION_STATUSES) {
    assert.equal(readPreparationStatus(status), status);
  }
});

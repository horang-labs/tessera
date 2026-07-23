import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { before } from 'node:test';

process.env.TESSERA_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'tessera-provider-session-test-'));
process.env.NODE_ENV = 'test';

let dbSessions: typeof import('@/lib/db/sessions');
let reconcileTerminalProviderSession: typeof import('@/lib/terminal/provider-session-reconciliation').reconcileTerminalProviderSession;
let createPendingTerminalProviderSessionFork: typeof import('@/lib/terminal/provider-session-reconciliation').createPendingTerminalProviderSessionFork;
let extractTerminalProviderSessionIdentity: typeof import('@/lib/terminal/provider-session-identity').extractTerminalProviderSessionIdentity;

before(async () => {
  const [{ initDatabase }, projects, sessions, reconciliation, identity] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/db/sessions'),
    import('@/lib/terminal/provider-session-reconciliation'),
    import('@/lib/terminal/provider-session-identity'),
  ]);
  await initDatabase();
  projects.registerProject('project-1', '/tmp/project-1', 'Project 1');
  dbSessions = sessions;
  reconcileTerminalProviderSession = reconciliation.reconcileTerminalProviderSession;
  createPendingTerminalProviderSessionFork = reconciliation.createPendingTerminalProviderSessionFork;
  extractTerminalProviderSessionIdentity = identity.extractTerminalProviderSessionIdentity;
});

test('the common identity adapter normalizes provider hook payloads', () => {
  assert.deepEqual(
    extractTerminalProviderSessionIdentity('opencode', {
      sessionID: ' opencode-child ',
      transcriptPath: ' /tmp/opencode-child.jsonl ',
    }),
    {
      providerId: 'opencode',
      providerSessionId: 'opencode-child',
      transcriptPath: '/tmp/opencode-child.jsonl',
    },
  );
  assert.equal(
    extractTerminalProviderSessionIdentity('codex', { session_id: 'bad\nidentifier' }),
    null,
  );
});

test('the first provider observation binds the existing PTY session without forking', () => {
  dbSessions.createSession('unbound-parent', 'project-1', 'Unbound PTY', 'codex', {
    providerState: JSON.stringify({ kind: 'terminal', launched: true }),
  });

  const result = reconcileTerminalProviderSession({
    sourceSessionId: 'unbound-parent',
    identity: { providerId: 'codex', providerSessionId: 'provider-initial' },
  });

  assert.deepEqual(result, {
    kind: 'unchanged',
    sessionId: 'unbound-parent',
    previousSessionId: 'unbound-parent',
  });
});

test('a new provider session creates one durable PTY child and preserves the parent', () => {
  dbSessions.createSession('parent-session', 'project-1', 'Investigate login', 'codex', {
    workDir: '/tmp/project-1',
    worktreeManaged: true,
    taskId: 'task-1',
    collectionId: 'collection-1',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    serviceTier: 'fast',
    providerState: JSON.stringify({
      kind: 'terminal',
      launched: true,
      codexSessionId: 'provider-parent',
    }),
  });
  dbSessions.updateSession('parent-session', {
    worktree_branch: 'feature/login',
    worktree_managed: 1,
  });

  const result = reconcileTerminalProviderSession({
    sourceSessionId: 'parent-session',
    identity: {
      providerId: 'codex',
      providerSessionId: 'provider-child',
      transcriptPath: '/tmp/provider-child.jsonl',
    },
  });

  assert.equal(result.kind, 'created');
  assert.equal(result.previousSessionId, 'parent-session');
  assert.equal(result.previousProviderSessionId, 'provider-parent');
  assert.notEqual(result.sessionId, 'parent-session');

  const parent = dbSessions.getSession('parent-session');
  const child = dbSessions.getSession(result.sessionId);
  assert.equal(parent?.title, 'Investigate login');
  assert.equal(child?.title, 'Investigate login (Fork)');
  assert.equal(child?.provider, 'codex');
  assert.equal(child?.project_id, 'project-1');
  assert.equal(child?.work_dir, '/tmp/project-1');
  assert.equal(child?.worktree_branch, 'feature/login');
  assert.equal(child?.worktree_managed, 1);
  assert.equal(child?.task_id, 'task-1');
  assert.equal(child?.collection_id, 'collection-1');
  assert.equal(child?.model, 'gpt-5.4');
  assert.equal(child?.reasoning_effort, 'high');
  assert.equal(child?.service_tier, 'fast');
  assert.deepEqual(JSON.parse(child?.provider_state ?? '{}'), {
    kind: 'terminal',
    launched: true,
    terminalProviderSessionId: 'provider-child',
    codexSessionId: 'provider-child',
  });
  assert.equal(result.projectId, 'project-1');
});

test('duplicate and stale-pane observations resolve to the existing child', () => {
  dbSessions.createSession('dedup-parent', 'project-1', 'Deduplicate fork', 'claude-code', {
    workDir: '/tmp/project-1',
    providerState: JSON.stringify({ kind: 'terminal', launched: true }),
  });

  const first = reconcileTerminalProviderSession({
    sourceSessionId: 'dedup-parent',
    identity: { providerId: 'claude-code', providerSessionId: 'claude-child' },
    activation: 'background',
  });
  assert.equal(first.kind, 'created');
  assert.deepEqual(JSON.parse(dbSessions.getSession(first.sessionId)?.provider_state ?? '{}'), {
    kind: 'terminal',
    launched: true,
    terminalProviderSessionId: 'claude-child',
    terminalProviderSessionActivation: 'background',
  });

  const duplicate = reconcileTerminalProviderSession({
    sourceSessionId: first.sessionId,
    identity: { providerId: 'claude-code', providerSessionId: 'claude-child' },
  });
  assert.deepEqual(duplicate, {
    kind: 'unchanged',
    sessionId: first.sessionId,
    previousSessionId: first.sessionId,
  });

  const stalePane = reconcileTerminalProviderSession({
    sourceSessionId: 'dedup-parent',
    identity: { providerId: 'claude-code', providerSessionId: 'claude-child' },
  });
  assert.deepEqual(stalePane, {
    kind: 'existing',
    sessionId: first.sessionId,
    previousSessionId: 'dedup-parent',
    previousProviderSessionId: 'dedup-parent',
  });
});

test('a reset fork waits for its provider identity and then adopts it', () => {
  dbSessions.createSession('reset-parent', 'project-1', 'Investigate login', 'codex', {
    workDir: '/tmp/project-1',
    providerState: JSON.stringify({
      kind: 'terminal',
      launched: true,
      codexSessionId: 'rollout-before-clear',
    }),
  });

  const fork = createPendingTerminalProviderSessionFork('reset-parent');
  assert.ok(fork);
  assert.equal(fork.projectId, 'project-1');
  const forked = dbSessions.getSession(fork.sessionId);
  // A reset starts an empty conversation, so it is titled like any new session
  // and the first prompt replaces the placeholder.
  assert.match(forked?.title ?? '', /^Session \d+$/u);
  assert.equal(forked?.provider, 'codex');
  assert.deepEqual(JSON.parse(forked?.provider_state ?? '{}'), {
    kind: 'terminal',
    launched: true,
    terminalProviderSessionPending: true,
  });

  // The rollout Codex mints on the next prompt belongs to the waiting session,
  // and no second fork is created for it.
  const adopted = reconcileTerminalProviderSession({
    sourceSessionId: fork.sessionId,
    identity: {
      providerId: 'codex',
      providerSessionId: 'rollout-after-clear',
      transcriptPath: '/tmp/rollout-after-clear.jsonl',
    },
  });
  assert.deepEqual(adopted, {
    kind: 'unchanged',
    sessionId: fork.sessionId,
    previousSessionId: fork.sessionId,
  });
  assert.deepEqual(JSON.parse(dbSessions.getSession(fork.sessionId)?.provider_state ?? '{}'), {
    kind: 'terminal',
    launched: true,
    terminalProviderSessionId: 'rollout-after-clear',
    codexSessionId: 'rollout-after-clear',
  });
  assert.equal(dbSessions.getSession('reset-parent')?.deleted, 0);
});

test('a reset that never happened hands the PTY back and drops the empty fork', () => {
  dbSessions.createSession('mispredicted-parent', 'project-1', 'Keep talking', 'codex', {
    providerState: JSON.stringify({
      kind: 'terminal',
      launched: true,
      codexSessionId: 'rollout-kept',
    }),
  });
  reconcileTerminalProviderSession({
    sourceSessionId: 'mispredicted-parent',
    identity: { providerId: 'codex', providerSessionId: 'rollout-kept' },
  });

  const fork = createPendingTerminalProviderSessionFork('mispredicted-parent');
  assert.ok(fork);

  const recovered = reconcileTerminalProviderSession({
    sourceSessionId: fork.sessionId,
    identity: { providerId: 'codex', providerSessionId: 'rollout-kept' },
  });
  assert.deepEqual(recovered, {
    kind: 'existing',
    sessionId: 'mispredicted-parent',
    previousSessionId: fork.sessionId,
  });
  assert.equal(dbSessions.getSession(fork.sessionId), undefined);
});

test('a PTY with no provider conversation yet is never pre-forked', () => {
  dbSessions.createSession('untouched-pty', 'project-1', 'Fresh PTY', 'codex', {
    providerState: JSON.stringify({ kind: 'terminal', launched: true }),
  });
  assert.equal(createPendingTerminalProviderSessionFork('untouched-pty'), null);

  dbSessions.createSession('gui-reset', 'project-1', 'GUI session', 'codex', {
    providerState: JSON.stringify({ kind: 'chat', threadId: 'thread-gui-reset' }),
  });
  assert.equal(createPendingTerminalProviderSessionFork('gui-reset'), null);
  assert.equal(createPendingTerminalProviderSessionFork('missing-session'), null);
});

test('a hook-reported reset is titled as a new session, a fork keeps the parent title', () => {
  dbSessions.createSession('origin-parent', 'project-1', 'Investigate login', 'claude-code', {
    providerState: JSON.stringify({ kind: 'terminal', launched: true }),
  });
  reconcileTerminalProviderSession({
    sourceSessionId: 'origin-parent',
    identity: { providerId: 'claude-code', providerSessionId: 'origin-parent-provider' },
  });

  const reset = reconcileTerminalProviderSession({
    sourceSessionId: 'origin-parent',
    identity: { providerId: 'claude-code', providerSessionId: 'cleared-child' },
    origin: 'reset',
  });
  assert.equal(reset.kind, 'created');
  assert.match(dbSessions.getSession(reset.sessionId)?.title ?? '', /^Session \d+$/u);

  const forked = reconcileTerminalProviderSession({
    sourceSessionId: 'origin-parent',
    identity: { providerId: 'claude-code', providerSessionId: 'branched-child' },
  });
  assert.equal(forked.kind, 'created');
  assert.equal(dbSessions.getSession(forked.sessionId)?.title, 'Investigate login (Fork)');
});

test('GUI sessions are ignored by the PTY provider-session reconciler', () => {
  dbSessions.createSession('gui-session', 'project-1', 'GUI session', 'codex', {
    providerState: JSON.stringify({ kind: 'chat', threadId: 'thread-gui' }),
  });

  const result = reconcileTerminalProviderSession({
    sourceSessionId: 'gui-session',
    identity: { providerId: 'codex', providerSessionId: 'provider-gui' },
  });

  assert.deepEqual(result, {
    kind: 'ignored',
    sessionId: 'gui-session',
    previousSessionId: 'gui-session',
  });
});

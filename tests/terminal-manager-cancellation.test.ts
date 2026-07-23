import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalManager } from '../src/lib/terminal/terminal-manager';
import type { TerminalProcessHandle, TerminalPtyFactory } from '../src/lib/terminal/types';
import {
  acquireTerminalHandoffLock,
  isSessionHandedOffToTerminal,
  releaseTerminalHandoffByTerminal,
} from '../src/lib/terminal/terminal-handoff-lock';

function installPendingPrefillRuntime(
  manager: TerminalManager,
  terminalId: string,
  userId: string,
): { writes: string[]; getCancelCount: () => number } {
  const writes: string[] = [];
  let cancelCount = 0;
  const process: TerminalProcessHandle = {
    write(data) { writes.push(data); },
    resize() {},
    kill() {},
  };
  const runtime = {
    terminalId,
    userId,
    sessionId: null,
    generation: 1,
    sequence: 0,
    ended: false,
    cwd: '.',
    shell: '/bin/zsh',
    process,
    model: { dispose() {}, resize() {} },
    subscribers: new Map([['connection:surface', {
      connectionId: 'connection',
      surfaceId: 'surface',
      ready: true,
      pendingFrames: [],
    }]]),
    viewportOwner: 'connection:surface',
    outputBuffer: [],
    outputBufferSize: 0,
    pendingSend: [],
    pendingSendTimer: null,
    disposeSessionObservers: [],
    prefillPending: true,
    cancelPrefill() {
      cancelCount += 1;
      runtime.prefillPending = false;
    },
  };
  const internals = manager as unknown as {
    terminals: Map<string, typeof runtime>;
  };
  internals.terminals.set(`${userId}:${terminalId}`, runtime);
  return { writes, getCancelCount: () => cancelCount };
}

test('closing a terminal while its PTY dependency loads cancels the spawn', async () => {
  let resolveLoader: ((factory: TerminalPtyFactory) => void) | undefined;
  let spawnCount = 0;
  const messages: Array<{ type: string; terminalId?: string; message?: string }> = [];
  const loader = new Promise<TerminalPtyFactory>((resolve) => {
    resolveLoader = resolve;
  });
  const manager = new TerminalManager(
    (_userId, message) => messages.push(message),
    () => loader,
  );
  const handoffSessionId = 'pending-handoff-session';
  assert.equal(acquireTerminalHandoffLock({
    sessionId: handoffSessionId,
    terminalId: 'pending-terminal',
    userId: 'pending-user',
  }), true);

  const creation = manager.create({
    terminalId: 'pending-terminal',
    userId: 'pending-user',
    connectionId: 'connection',
    surfaceId: 'surface',
    launchSpec: {
      program: 'codex',
      args: [],
      prefillInput: '/theme',
      cwd: process.cwd(),
      handoffSessionId,
    },
  });

  manager.close('pending-terminal', 'pending-user');
  assert.equal(isSessionHandedOffToTerminal(handoffSessionId), false);
  resolveLoader?.({
    spawn() {
      spawnCount += 1;
      throw new Error('cancelled create must not spawn');
    },
  });
  await creation;

  assert.equal(spawnCount, 0);
  assert.equal(manager.hasOrIsOpening('pending-terminal', 'pending-user'), false);
  assert.equal(messages.some((message) => message.type === 'terminal_started'), false);
  assert.equal(messages.some(
    (message) => message.type === 'terminal_error'
      && message.message === 'Terminal startup was cancelled.',
  ), true);
});

test('releasing a preview during startup cancels only its owned spawn', async () => {
  let resolveLoader: ((factory: TerminalPtyFactory) => void) | undefined;
  let spawnCount = 0;
  const loader = new Promise<TerminalPtyFactory>((resolve) => {
    resolveLoader = resolve;
  });
  const manager = new TerminalManager(() => {}, () => loader);
  const creation = manager.create({
    terminalId: 'preview-terminal',
    userId: 'preview-user',
    connectionId: 'disconnected-connection',
    surfaceId: 'preview-surface',
    previewOwnerToken: 'preview-owner',
    cwd: process.cwd(),
  });

  await manager.releasePreview(
    'preview-terminal',
    'preview-user',
    null,
    'different-preview',
  );
  assert.equal(manager.hasOrIsOpening('preview-terminal', 'preview-user'), true);

  const release = manager.releasePreview(
    'preview-terminal',
    'preview-user',
    null,
    'preview-owner',
  );
  resolveLoader?.({
    spawn() {
      spawnCount += 1;
      throw new Error('released preview must not spawn');
    },
  });
  await Promise.all([creation, release]);

  assert.equal(spawnCount, 0);
  assert.equal(manager.hasOrIsOpening('preview-terminal', 'preview-user'), false);
});

test('closing a running handoff keeps its lease until PTY exit confirmation', () => {
  const userId = 'closing-user';
  const terminalId = 'closing-terminal';
  const sessionId = 'closing-session';
  let killCount = 0;
  assert.equal(acquireTerminalHandoffLock({ sessionId, terminalId, userId }), true);

  const runtime = {
    terminalId,
    userId,
    sessionId: null,
    generation: 1,
    sequence: 0,
    ended: false,
    cwd: '.',
    shell: '/bin/zsh',
    process: {
      write() {},
      resize() {},
      kill() { killCount += 1; },
    },
    model: { dispose() {}, resize() {} },
    subscribers: new Map(),
    viewportOwner: null,
    outputBuffer: [],
    outputBufferSize: 0,
    pendingSend: [],
    pendingSendTimer: null,
    disposeSessionObservers: [],
    handoffSessionId: sessionId,
  };
  const manager = new TerminalManager(() => undefined);
  const internals = manager as unknown as {
    terminals: Map<string, typeof runtime>;
  };
  internals.terminals.set(`${userId}:${terminalId}`, runtime);

  manager.close(terminalId, userId);

  assert.equal(killCount, 1);
  assert.equal(isSessionHandedOffToTerminal(sessionId), true);
  releaseTerminalHandoffByTerminal(userId, terminalId);
});

test('a close watchdog releases a handoff after PID death when onExit is missing', async () => {
  const userId = 'watchdog-user';
  const terminalId = 'watchdog-terminal';
  const sessionId = 'watchdog-session';
  let alive = true;
  const signals: Array<string | undefined> = [];
  assert.equal(acquireTerminalHandoffLock({ sessionId, terminalId, userId }), true);

  const runtime = {
    terminalId,
    userId,
    sessionId: null,
    generation: 1,
    sequence: 0,
    ended: false,
    cwd: '.',
    shell: '/bin/zsh',
    process: {
      pid: 4242,
      write() {},
      resize() {},
      kill(signal?: string) {
        signals.push(signal);
        if (signals.length === 2) alive = false;
      },
    },
    model: { dispose() {}, resize() {} },
    subscribers: new Map(),
    viewportOwner: null,
    outputBuffer: [],
    outputBufferSize: 0,
    pendingSend: [],
    pendingSendTimer: null,
    disposeSessionObservers: [],
    handoffSessionId: sessionId,
  };
  const manager = new TerminalManager(
    () => undefined,
    undefined,
    undefined,
    { closeExitGraceMs: 0, closeExitPollMs: 1, processIsAlive: () => alive },
  );
  const internals = manager as unknown as {
    terminals: Map<string, typeof runtime>;
  };
  internals.terminals.set(`${userId}:${terminalId}`, runtime);

  manager.close(terminalId, userId);
  const deadline = Date.now() + 250;
  while (isSessionHandedOffToTerminal(sessionId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(signals[0], undefined);
  assert.equal(signals.length, 2);
  assert.equal(isSessionHandedOffToTerminal(sessionId), false);
  assert.equal(manager.hasOrIsOpening(terminalId, userId), false);
});

test('a throwing kill retains a live TUI handoff lease', async () => {
  const userId = 'kill-error-user';
  const terminalId = 'kill-error-terminal';
  const sessionId = 'kill-error-session';
  assert.equal(acquireTerminalHandoffLock({ sessionId, terminalId, userId }), true);

  const runtime = {
    terminalId,
    userId,
    sessionId: null,
    generation: 1,
    sequence: 0,
    ended: false,
    cwd: '.',
    shell: '/bin/zsh',
    process: {
      pid: 4343,
      write() {},
      resize() {},
      kill() { throw new Error('still alive'); },
    },
    model: { dispose() {}, resize() {} },
    subscribers: new Map(),
    viewportOwner: null,
    outputBuffer: [],
    outputBufferSize: 0,
    pendingSend: [],
    pendingSendTimer: null,
    disposeSessionObservers: [],
    handoffSessionId: sessionId,
  };
  const manager = new TerminalManager(
    () => undefined,
    undefined,
    undefined,
    { closeExitGraceMs: 0, closeExitPollMs: 10_000, processIsAlive: () => true },
  );
  const internals = manager as unknown as {
    terminals: Map<string, typeof runtime>;
  };
  internals.terminals.set(`${userId}:${terminalId}`, runtime);

  manager.close(terminalId, userId);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(isSessionHandedOffToTerminal(sessionId), true);
  assert.equal(manager.hasOrIsOpening(terminalId, userId), true);
  internals.terminals.clear();
  releaseTerminalHandoffByTerminal(userId, terminalId);
});

test('xterm protocol replies do not cancel a pending command prefill', () => {
  const protocolReplies = [
    '\x1b[I',
    '\x1b[1;1R',
    '\x1b[?1;1R',
    '\x1b[0n',
    '\x1b[?1;2$y',
    '\x1b[4;1000;1500t',
    '\x1b[6;18;9t',
    '\x1b[8;24;80t',
    '\x1b]4;1;rgb:d7d7/dddd/e3e3\x1b\\',
    '\x1b]10;rgb:d7d7/dddd/e3e3\x1b\\',
    '\x1b]11;rgb:0f0f/1111/1515\x1b\\',
    '\x1b]12;rgb:d7d7/dddd/e3e3\x1b\\',
    '\x1b[?1;2c',
    '\x1b[>0;276;0c',
    '\x1bP1$r0m\x1b\\',
  ];
  const manager = new TerminalManager(() => undefined);
  const runtime = installPendingPrefillRuntime(manager, 'protocol-terminal', 'protocol-user');

  for (const reply of [...protocolReplies, protocolReplies.join('')]) {
    manager.write('protocol-terminal', 'protocol-user', 'connection', 'surface', reply);
  }

  assert.equal(runtime.getCancelCount(), 0);
  assert.deepEqual(runtime.writes, [...protocolReplies, protocolReplies.join('')]);
});

test('split xterm protocol replies do not cancel a pending command prefill', () => {
  const replies = [
    '\x1b[>0;276;0c',
    '\x1b[?1;2$y',
    '\x1b[4;1000;1500t',
    '\x1b]10;rgb:d7d7/dddd/e3e3\x1b\\',
    '\x1bP1$r0m\x1b\\',
  ];
  const manager = new TerminalManager(() => undefined);
  const runtime = installPendingPrefillRuntime(manager, 'split-protocol-terminal', 'protocol-user');

  for (const reply of replies) {
    for (const byte of reply) {
      manager.write('split-protocol-terminal', 'protocol-user', 'connection', 'surface', byte);
    }
  }

  assert.equal(runtime.getCancelCount(), 0);
  assert.deepEqual(runtime.writes, replies.flatMap((reply) => [...reply]));
});

test('an incomplete response-shaped user escape cancels after the fragment grace period', async () => {
  const manager = new TerminalManager(() => undefined);
  const runtime = installPendingPrefillRuntime(manager, 'partial-escape-terminal', 'input-user');

  manager.write('partial-escape-terminal', 'input-user', 'connection', 'surface', '\x1b');
  assert.equal(runtime.getCancelCount(), 0);
  await new Promise((resolve) => setTimeout(resolve, 125));

  assert.equal(runtime.getCancelCount(), 1);
  assert.deepEqual(runtime.writes, ['\x1b']);
});

test('real keyboard and paste data still cancel a pending command prefill', () => {
  const userInputs = [
    'x',
    '\r',
    '\t',
    '\x1b[A',
    '\x1b[200~pasted text\x1b[201~',
  ];

  for (const [index, input] of userInputs.entries()) {
    const terminalId = `user-input-terminal-${index}`;
    const manager = new TerminalManager(() => undefined);
    const runtime = installPendingPrefillRuntime(manager, terminalId, 'input-user');
    manager.write(terminalId, 'input-user', 'connection', 'surface', input);
    assert.equal(runtime.getCancelCount(), 1, JSON.stringify(input));
    assert.deepEqual(runtime.writes, [input]);
  }
});

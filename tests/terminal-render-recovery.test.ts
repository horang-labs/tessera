import assert from 'node:assert/strict';
import test from 'node:test';
import {
  QuietTerminalRenderRecovery,
  TerminalBackgroundSgrDetector,
  resetAndRefreshTerminalRenderers,
  type TerminalRenderRecoveryScheduler,
} from '@/lib/terminal/terminal-render-recovery';

test('terminal background SGR detection covers Codex blocks without mistaking foreground RGB', () => {
  const detector = new TerminalBackgroundSgrDetector();

  assert.equal(detector.consume('\x1b[48;2;12;34;56m codex input \x1b[0m'), true);
  assert.equal(detector.consume('\x1b[48:2::12:34:56m codex input \x1b[0m'), true);
  assert.equal(detector.consume('\x1b[44m selected block \x1b[0m'), true);
  assert.equal(detector.consume('\x1b[104m bright selected block \x1b[0m'), true);
  assert.equal(detector.consume('\x1b[38;2;48;34;56m foreground only\x1b[0m'), false);
  assert.equal(detector.consume('\x1b[38:2::48:34:56m foreground only\x1b[0m'), false);
});

test('terminal background SGR detection survives websocket chunk boundaries', () => {
  const detector = new TerminalBackgroundSgrDetector();

  assert.equal(detector.consume('prefix\x1b[48;2;12'), false);
  assert.equal(detector.consume(';34;56m block'), true);
});

test('terminal render recovery runs once after 200ms of quiet', () => {
  let nextId = 1;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const scheduler: TerminalRenderRecoveryScheduler = {
    clearTimeout: (id) => timers.delete(id),
    setTimeout: (callback, delay) => {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
  };
  let recoveries = 0;
  const recovery = new QuietTerminalRenderRecovery(() => {
    recoveries += 1;
  }, scheduler);

  recovery.request();
  recovery.request();

  assert.equal(timers.size, 1);
  const pending = timers.values().next().value as { callback: () => void; delay: number };
  assert.equal(pending.delay, 200);
  assert.equal(recoveries, 0);
  pending.callback();
  assert.equal(recoveries, 1);
});

test('shared WebGL recovery resets every atlas before refreshing every terminal', () => {
  const calls: string[] = [];
  const targets = ['first', 'second'].map((name) => ({
    refreshTerminalViewport: () => calls.push(`refresh:${name}`),
    resetWebglTextureAtlas: () => calls.push(`reset:${name}`),
  }));

  resetAndRefreshTerminalRenderers(targets);

  assert.deepEqual(calls, [
    'reset:first',
    'reset:second',
    'refresh:first',
    'refresh:second',
  ]);
});

test('shared WebGL recovery still refreshes a surface whose atlas reset throws', () => {
  const calls: string[] = [];
  const targets = [
    {
      refreshTerminalViewport: () => calls.push('refresh:first'),
      resetWebglTextureAtlas: () => {
        calls.push('reset:first');
        throw new Error('context already lost');
      },
    },
    {
      refreshTerminalViewport: () => calls.push('refresh:second'),
      resetWebglTextureAtlas: () => calls.push('reset:second'),
    },
  ];

  resetAndRefreshTerminalRenderers(targets);

  assert.deepEqual(calls, [
    'reset:first',
    'reset:second',
    'refresh:first',
    'refresh:second',
  ]);
});

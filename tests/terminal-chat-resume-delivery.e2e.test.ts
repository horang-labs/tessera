import assert from 'node:assert/strict';
import test from 'node:test';

import { sendTerminalChatMessage } from '@/lib/terminal/terminal-chat-send';
import {
  getSessionTerminalId,
  getTerminalSurface,
  type TerminalSurface,
} from '@/lib/terminal/terminal-surface-registry';
import { getTerminalTheme } from '@/lib/terminal/terminal-theme';
import { wsClient } from '@/lib/ws/client';
import type { ServerTransportMessage } from '@/lib/ws/message-types';

type SurfaceHarness = {
  surface: TerminalSurface;
  send: (message: ServerTransportMessage) => void;
};

function createSurface(sessionId: string, name: string): SurfaceHarness {
  const terminalId = getSessionTerminalId(sessionId);
  const surface = getTerminalSurface({
    registryKey: `terminal-chat-resume:${name}:${sessionId}`,
    terminalId,
    theme: getTerminalTheme(true),
    appearanceMode: 'dark',
    fontSize: 14,
  });
  const internals = surface as unknown as {
    terminal: { paste(data: string): void; dispose(): void };
    handleServerMessage(message: ServerTransportMessage): void;
  };
  internals.terminal = {
    paste: (data) => { surface.sendInput(data); },
    dispose: () => undefined,
  };
  return { surface, send: (message) => internals.handleServerMessage(message) };
}

function started(surface: TerminalSurface, terminalId: string, generation: number): ServerTransportMessage {
  return {
    type: 'terminal_started',
    terminalId,
    surfaceId: surface.surfaceId,
    generation,
    cwd: '/tmp',
    shell: 'codex',
    reattached: false,
  };
}

test('post-resume terminal chat targets the newest surface generation', async () => {
  const sessionId = 'post-resume-delivery';
  const terminalId = getSessionTerminalId(sessionId);
  const stale = createSurface(sessionId, 'stale');
  const conflict = createSurface(sessionId, 'conflict');
  const resumed = createSurface(sessionId, 'resumed');
  const originalSendTerminalInput = wsClient.sendTerminalInput;
  const sent: Array<{ surfaceId: string; data: string }> = [];

  wsClient.sendTerminalInput = (_terminalId, surfaceId, data) => {
    sent.push({ surfaceId, data });
    return true;
  };

  try {
    // The detached old surface missed generation 1's exit. A second surface
    // observed the external-ownership rejection, then Tessera resumed as gen 2.
    stale.send(started(stale.surface, terminalId, 1));
    conflict.send({
      type: 'terminal_error',
      terminalId,
      surfaceId: conflict.surface.surfaceId,
      message: 'already open in another runtime',
    });
    resumed.send(started(resumed.surface, terminalId, 2));

    const handle = sendTerminalChatMessage(sessionId, 'post-resume prompt');
    assert.ok(handle);
    assert.equal(await handle.submitted, true);

    assert.deepEqual(sent, [
      { surfaceId: resumed.surface.surfaceId, data: 'post-resume prompt' },
      { surfaceId: resumed.surface.surfaceId, data: '\r' },
    ]);
  } finally {
    wsClient.sendTerminalInput = originalSendTerminalInput;
    stale.surface.dispose({ detach: false });
    conflict.surface.dispose({ detach: false });
    resumed.surface.dispose({ detach: false });
  }
});

test('terminal chat never sends Enter to a generation that did not receive the prompt', async () => {
  const sessionId = 'generation-change-during-send';
  const terminalId = getSessionTerminalId(sessionId);
  const first = createSurface(sessionId, 'first');
  const resumed = createSurface(sessionId, 'resumed');
  const originalSendTerminalInput = wsClient.sendTerminalInput;
  const sent: Array<{ surfaceId: string; data: string }> = [];

  wsClient.sendTerminalInput = (_terminalId, surfaceId, data) => {
    sent.push({ surfaceId, data });
    return true;
  };

  try {
    first.send(started(first.surface, terminalId, 1));
    const handle = sendTerminalChatMessage(sessionId, 'one generation only');
    assert.ok(handle);

    resumed.send(started(resumed.surface, terminalId, 2));
    const submitted = await handle.submitted;

    assert.equal(submitted, false);
    assert.deepEqual(sent, [
      { surfaceId: first.surface.surfaceId, data: 'one generation only' },
    ]);
  } finally {
    wsClient.sendTerminalInput = originalSendTerminalInput;
    first.surface.dispose({ detach: false });
    resumed.surface.dispose({ detach: false });
  }
});

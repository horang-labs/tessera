import assert from 'node:assert/strict';
import test from 'node:test';

import { sendTerminalChatInterrupt } from '@/lib/terminal/terminal-chat-send';
import {
  getSessionTerminalId,
  getTerminalSurface,
} from '@/lib/terminal/terminal-surface-registry';
import { getTerminalTheme } from '@/lib/terminal/terminal-theme';
import { wsClient } from '@/lib/ws/client';
import type { AppServerMessage } from '@/lib/ws/message-types';

type TerminalSurfaceInternals = {
  handleServerMessage: (message: AppServerMessage) => void;
};

function advertiseInterruptPolicy(
  surface: ReturnType<typeof getTerminalSurface>,
  terminalId: string,
  policy: 'none' | 'single-escape',
): void {
  (surface as unknown as TerminalSurfaceInternals).handleServerMessage({
    type: 'terminal_started',
    terminalId,
    surfaceId: surface.surfaceId,
    generation: 1,
    cwd: '/tmp',
    shell: 'test-shell',
    reattached: false,
    interruptInputPolicy: policy,
  });
}

test('terminal chat interrupt sends one Escape key to the session PTY', () => {
  const sessionId = 'terminal-chat-interrupt-test';
  const terminalId = getSessionTerminalId(sessionId);
  const surface = getTerminalSurface({
    registryKey: `terminal-chat-interrupt:${sessionId}`,
    terminalId,
    theme: getTerminalTheme(true),
    appearanceMode: 'dark',
    fontSize: 14,
  });
  const originalSendTerminalInput = wsClient.sendTerminalInput;
  const sent: Array<{ terminalId: string; surfaceId: string; data: string }> = [];

  wsClient.sendTerminalInput = (sentTerminalId, surfaceId, data) => {
    sent.push({ terminalId: sentTerminalId, surfaceId, data });
    return true;
  };

  try {
    advertiseInterruptPolicy(surface, terminalId, 'single-escape');
    assert.equal(sendTerminalChatInterrupt(sessionId), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.terminalId, terminalId);
    assert.ok(sent[0]?.surfaceId);
    assert.equal(sent[0]?.data, '\x1b');
  } finally {
    wsClient.sendTerminalInput = originalSendTerminalInput;
    surface.dispose({ detach: false });
  }
});

test('terminal chat does not claim Escape cancellation for an unsupported provider', () => {
  const sessionId = 'terminal-chat-interrupt-unsupported-test';
  const terminalId = getSessionTerminalId(sessionId);
  const surface = getTerminalSurface({
    registryKey: `terminal-chat-interrupt:${sessionId}`,
    terminalId,
    theme: getTerminalTheme(true),
    appearanceMode: 'dark',
    fontSize: 14,
  });
  const originalSendTerminalInput = wsClient.sendTerminalInput;
  let sendCount = 0;

  wsClient.sendTerminalInput = () => {
    sendCount += 1;
    return true;
  };

  try {
    advertiseInterruptPolicy(surface, terminalId, 'none');
    assert.equal(sendTerminalChatInterrupt(sessionId), false);
    assert.equal(sendCount, 0);
  } finally {
    wsClient.sendTerminalInput = originalSendTerminalInput;
    surface.dispose({ detach: false });
  }
});

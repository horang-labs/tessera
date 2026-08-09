import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getTerminalSurface,
  type TerminalSurface,
} from '@/lib/terminal/terminal-surface-registry';
import { getTerminalTheme } from '@/lib/terminal/terminal-theme';
import { wsClient } from '@/lib/ws/client';

function createSurface(registryKey: string): TerminalSurface {
  return getTerminalSurface({
    registryKey,
    terminalId: 'shared-user-input-test-terminal',
    theme: getTerminalTheme(true),
    appearanceMode: 'dark',
    fontSize: 14,
  });
}

test('user input notifies only the exact surface that owns the input bar', () => {
  const originalSendTerminalInput = wsClient.sendTerminalInput;
  const first = createSurface('user-input-owner:first');
  const second = createSurface('user-input-owner:second');
  const sentSurfaceIds: string[] = [];
  let firstNotifications = 0;
  let secondNotifications = 0;

  first.setInputListener(() => {
    firstNotifications += 1;
  });
  second.setInputListener(() => {
    secondNotifications += 1;
  });
  wsClient.sendTerminalInput = (_terminalId, surfaceId) => {
    sentSurfaceIds.push(surfaceId);
    return true;
  };

  try {
    assert.equal(first.sendUserInput('from the first bar'), true);
    assert.deepEqual(sentSurfaceIds, [first.surfaceId]);
    assert.equal(firstNotifications, 1);
    assert.equal(secondNotifications, 0);
  } finally {
    wsClient.sendTerminalInput = originalSendTerminalInput;
    first.dispose({ detach: false });
    second.dispose({ detach: false });
  }
});

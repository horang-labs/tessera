import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getTerminalSurface,
  pasteInputToRunningTerminal,
  type TerminalSurface,
  type TerminalSurfaceSnapshot,
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

test('user paste uses the exact surface paste path and notifies only after delivery', () => {
  const first = createSurface('user-paste-owner:first');
  const second = createSurface('user-paste-owner:second');
  const pasted: string[] = [];
  let firstNotifications = 0;
  let secondNotifications = 0;

  first.setInputListener(() => {
    firstNotifications += 1;
  });
  second.setInputListener(() => {
    secondNotifications += 1;
  });
  Reflect.set(first, 'terminal', {
    paste: (data: string) => pasted.push(data),
  });

  try {
    const imagePath = '/tmp/tessera-uploads/phone image.png';
    assert.equal(first.pasteUserInput(imagePath), true);
    assert.deepEqual(pasted, [imagePath]);
    assert.equal(pasted[0].includes('\r'), false, 'image paste must not append Enter');
    assert.equal(firstNotifications, 1);
    assert.equal(secondNotifications, 0);

    Reflect.set(first, 'terminal', null);
    assert.equal(first.pasteUserInput('/tmp/unavailable.png'), false);
    assert.equal(firstNotifications, 1, 'a rejected paste must not pin the preview');
  } finally {
    Reflect.set(first, 'terminal', null);
    first.dispose({ detach: false });
    second.dispose({ detach: false });
  }
});

test('preloaded setup input waits for a running terminal surface', () => {
  const surface = createSurface('preloaded-setup-input');
  const pasted: string[] = [];
  const internals = surface as unknown as { state: TerminalSurfaceSnapshot };
  Reflect.set(surface, 'terminal', { paste: (data: string) => pasted.push(data) });

  try {
    assert.equal(pasteInputToRunningTerminal('shared-user-input-test-terminal', 'npx skills add'), false);
    assert.deepEqual(pasted, []);

    internals.state = { ...internals.state, status: 'running' };
    assert.equal(pasteInputToRunningTerminal('shared-user-input-test-terminal', 'npx skills add'), true);
    assert.deepEqual(pasted, ['npx skills add']);
  } finally {
    Reflect.set(surface, 'terminal', null);
    surface.dispose({ detach: false });
  }
});

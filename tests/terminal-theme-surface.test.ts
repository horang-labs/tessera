import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TerminalSurface,
  type TerminalSurfaceSnapshot,
} from '@/lib/terminal/terminal-surface-registry';
import {
  getTerminalTheme,
  type TesseraTerminalTheme,
} from '@/lib/terminal/terminal-theme';
import { wsClient } from '@/lib/ws/client';
import type { ServerTransportMessage } from '@/lib/ws/message-types';

test('a failed live appearance send retains the selected palette for reconnect', () => {
  const surface = new TerminalSurface({
    registryKey: 'theme-reconnect-test',
    terminalId: 'theme-reconnect-test',
    theme: getTerminalTheme(false),
    appearanceMode: 'light',
    fontSize: 14,
  });
  const internals = surface as unknown as {
    attachedConnectionGeneration: number;
    state: TerminalSurfaceSnapshot;
    theme: TesseraTerminalTheme;
  };
  internals.attachedConnectionGeneration = 1;
  internals.state = { ...internals.state, status: 'running' };

  const originalSetTerminalAppearance = wsClient.setTerminalAppearance;
  wsClient.setTerminalAppearance = () => false;
  try {
    surface.setTheme(getTerminalTheme(false, 'blue-frost'), 'light');
    assert.equal(internals.theme.background, '#f3f7fb');
    assert.equal(internals.theme.foreground, '#1f2933');
  } finally {
    wsClient.setTerminalAppearance = originalSetTerminalAppearance;
    surface.dispose({ detach: false });
  }
});

test('cold reattach resends an unacknowledged preset selection', () => {
  const surface = new TerminalSurface({
    registryKey: 'theme-reattach-test',
    terminalId: 'theme-reattach-test',
    theme: getTerminalTheme(false),
    appearanceMode: 'light',
    fontSize: 14,
  });
  const internals = surface as unknown as {
    handleServerMessage(message: ServerTransportMessage): void;
  };
  const selectedTheme = getTerminalTheme(false, 'blue-frost');
  surface.setTheme(selectedTheme, 'light');

  const appearances: Array<{ background: string; foreground: string }> = [];
  const originalSetTerminalAppearance = wsClient.setTerminalAppearance;
  wsClient.setTerminalAppearance = (_terminalId, _surfaceId, appearance) => {
    appearances.push(appearance);
    return true;
  };
  try {
    internals.handleServerMessage({
      type: 'terminal_started',
      terminalId: 'theme-reattach-test',
      surfaceId: surface.surfaceId,
      generation: 1,
      cwd: '/tmp',
      shell: 'test-shell',
      reattached: true,
      appearance: {
        mode: 'light',
        background: getTerminalTheme(false).background,
        foreground: getTerminalTheme(false).foreground,
      },
    });
    assert.deepEqual(appearances, [{
      background: selectedTheme.background,
      foreground: selectedTheme.foreground,
      mode: 'light',
    }]);
  } finally {
    wsClient.setTerminalAppearance = originalSetTerminalAppearance;
    surface.dispose({ detach: false });
  }
});

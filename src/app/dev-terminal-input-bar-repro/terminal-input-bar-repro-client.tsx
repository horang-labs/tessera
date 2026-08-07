'use client';

import { useEffect } from 'react';
import { TerminalPanel } from '@/components/terminal/terminal-panel';
import { wsClient } from '@/lib/ws/client';

/**
 * A bare mount of the real `TerminalPanel`, for verifying the Terminal input bar (#243).
 *
 * The bar is rendered by `TerminalPanel` and by nothing else, so a test that wants to
 * watch it appear at a Phone viewport and vanish above one has to mount that component.
 * Every other route to it needs a project, a session and a provider CLI first — none of
 * which the bar depends on, and all of which would make the test measure something else.
 *
 * Deliberately no props beyond the minimum: no header, no session ownership, no launch.
 * The panel is the subject, not the fixture around it.
 *
 * No cwd, so the server never starts a PTY behind this surface ("Terminal cwd is
 * required"). That is on purpose. The bar's job ends when the bytes are on the socket,
 * and a live shell would only add its own startup, its rc files and its prompt to what a
 * test has to reason about — the same reason the touch-scroll repro drives the buffer
 * directly instead of running a program.
 */

const REPRO_PANEL_ID = 'dev-terminal-input-bar-repro-panel';
const REPRO_TERMINAL_ID = 'dev-terminal-input-bar-repro';

export function TerminalInputBarReproClient() {
  useEffect(() => {
    wsClient.connect('terminal-input-bar-repro');
  }, []);

  return (
    <main className="flex h-dvh flex-col" data-testid="terminal-input-bar-repro">
      <TerminalPanel
        panelId={REPRO_PANEL_ID}
        terminalId={REPRO_TERMINAL_ID}
        terminalSessionId={null}
        surfaceActive
        showHeader={false}
      />
    </main>
  );
}

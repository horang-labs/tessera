import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProviderTerminalLaunch } from '@/lib/terminal/provider-launch';

test('OpenCode PTY starts the native TUI without observer-only launch flags', () => {
  assert.deepEqual(
    buildProviderTerminalLaunch({
      providerId: 'opencode',
      sessionId: 'tessera-session',
      resume: false,
    }),
    {
      command: 'opencode',
      args: [],
    },
  );
});

test('OpenCode PTY resumes only the ID captured for its terminal session', () => {
  assert.deepEqual(
    buildProviderTerminalLaunch({
      providerId: 'opencode',
      sessionId: 'tessera-session',
      resume: true,
      opencodeResumeId: 'ses_123',
    }),
    {
      command: 'opencode',
      args: ['--session', 'ses_123'],
    },
  );
});

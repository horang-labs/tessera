import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProviderTerminalLaunch } from '@/lib/terminal/provider-launch';

test('Codex PTY starts with pre-trusted overlay hooks and no trust-bypass warning flag', () => {
  assert.deepEqual(
    buildProviderTerminalLaunch({
      providerId: 'codex',
      sessionId: 'tessera-session',
      resume: false,
    }),
    {
      command: 'codex',
      args: [],
    },
  );
});

test('Codex PTY resumes with pre-trusted overlay hooks and no trust-bypass warning flag', () => {
  assert.deepEqual(
    buildProviderTerminalLaunch({
      providerId: 'codex',
      sessionId: 'tessera-session',
      resume: true,
      codexResumeId: 'thread_123',
    }),
    {
      command: 'codex',
      args: ['resume', 'thread_123'],
    },
  );
});

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

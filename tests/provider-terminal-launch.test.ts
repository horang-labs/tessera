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

test('Claude PTY starts an empty Tessera session with --session-id', () => {
  assert.deepEqual(
    buildProviderTerminalLaunch({
      providerId: 'claude-code',
      sessionId: 'tessera-session',
      resume: false,
      settingsJson: '{"hooks":{}}',
    }),
    {
      command: 'claude',
      args: ['--session-id', 'tessera-session', '--settings', '{"hooks":{}}'],
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

test('Claude PTY uses --resume only for a persisted Tessera conversation', () => {
  assert.deepEqual(
    buildProviderTerminalLaunch({
      providerId: 'claude-code',
      sessionId: 'tessera-session',
      resume: true,
      settingsJson: '{"hooks":{}}',
    }),
    {
      command: 'claude',
      args: ['--resume', 'tessera-session', '--settings', '{"hooks":{}}'],
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

test('Codex theme restart resumes only the captured terminal rollout id', () => {
  assert.deepEqual(
    buildProviderTerminalLaunch({
      providerId: 'codex',
      sessionId: 'tessera-session',
      resume: true,
      codexResumeId: '019c-rollout-id',
    }),
    {
      command: 'codex',
      args: ['resume', '019c-rollout-id'],
    },
  );
});

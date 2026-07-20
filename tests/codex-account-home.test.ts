import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  buildCodexAccountEnvironment,
  resolveCodexAccountHome,
} from '../src/lib/codex-home';

test('global Codex account lookup escapes a Tessera session overlay', () => {
  const homeDir = path.join(path.parse(process.cwd()).root, 'Users', 'test');
  const home = resolveCodexAccountHome({
    env: {
      CODEX_HOME: path.join(homeDir, '.tessera', 'codex-overlay', 'session-123'),
    },
    homeDir,
  });

  assert.equal(home, path.join(homeDir, '.codex'));
});

test('global Codex account lookup preserves a real custom home', () => {
  const homeDir = path.join(path.parse(process.cwd()).root, 'Users', 'test');
  const customHome = path.join(path.parse(process.cwd()).root, 'accounts', 'codex-work');
  const home = resolveCodexAccountHome({
    env: {
      CODEX_HOME: customHome,
    },
    homeDir,
  });

  assert.equal(home, customHome);
});

test('WSL account lookup leaves CODEX_HOME to the Linux login environment', () => {
  const env = buildCodexAccountEnvironment({
    CODEX_HOME: String.raw`C:\Users\test\.tessera\codex-overlay\session-123`,
    PATH: String.raw`C:\Windows\System32`,
  }, 'wsl');

  assert.equal(env.CODEX_HOME, undefined);
  assert.equal(env.PATH, String.raw`C:\Windows\System32`);
});

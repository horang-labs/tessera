import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  invalidateClaudeConfigDirCache,
  resolveClaudeConfigDirForEnvironment,
} from '../src/lib/skill/skill-loader';

const skillLoaderSource = fs.readFileSync(
  new URL('../src/lib/skill/skill-loader.ts', import.meta.url),
  'utf8',
);
const codexMemorySource = fs.readFileSync(
  new URL('../src/lib/memory/codex-memory.ts', import.meta.url),
  'utf8',
);
const opencodeMemorySource = fs.readFileSync(
  new URL('../src/lib/memory/opencode-memory.ts', import.meta.url),
  'utf8',
);
const spawnCliSource = fs.readFileSync(
  new URL('../src/lib/cli/spawn-cli.ts', import.meta.url),
  'utf8',
);
const cliExecSource = fs.readFileSync(
  new URL('../src/lib/cli/cli-exec.ts', import.meta.url),
  'utf8',
);

/** The probe block for one CLI environment: from the environment guard to the
 *  `execCli(` call plus its argument list, with line comments stripped. Comments
 *  here explain the login-shell trade-off by name (`loginShell: false`), so they
 *  must not count as code — only the actual call should. Lets each provider be
 *  asserted in isolation without matching another provider's probe. */
function wslProbeBlock(source: string): string {
  const start = source.indexOf(`environment === "wsl" && process.platform === "win32"`);
  const alt = source.indexOf(`environment === 'wsl' && process.platform === 'win32'`);
  const from = start === -1 ? alt : start;
  assert.notEqual(from, -1, 'expected a wsl+win32 probe block');
  const call = source.indexOf('execCli', from);
  // include the whole execCli(...) call — up to the line with the closing `);`
  const end = source.indexOf(');', call);
  const block = source.slice(from, end + 2);
  return block.replace(/^[^\n'"`]*\/\/.*$/gm, '');
}

// ── Login-shell cost: claude/opencode skip it, codex must keep it ────────────
//
// The wsl-on-Windows config-dir probe spawns `wsl <shell> -c`. Using the user's
// `-i -l` login shell re-sources their rc (nvm, oh-my-zsh, p10k) on every call —
// hundreds of ms, three times per Context-tab open. `wslpath`/`$HOME` need none
// of that, so claude and opencode pass `loginShell: false`. codex must NOT: its
// probe reads `$CODEX_HOME` from the rc, and the real codex CLI is spawned
// through the login shell, so the panel would otherwise disagree with the CLI.

test('claude config-dir probe skips the login shell', () => {
  assert.match(wslProbeBlock(skillLoaderSource), /loginShell:\s*false/);
});

test('opencode config-dir probe skips the login shell', () => {
  assert.match(wslProbeBlock(opencodeMemorySource), /loginShell:\s*false/);
});

test('codex home probe keeps the login shell (reads $CODEX_HOME from rc)', () => {
  const block = wslProbeBlock(codexMemorySource);
  assert.doesNotMatch(block, /loginShell:\s*false/,
    'codex must keep the login shell so it sees the same $CODEX_HOME the CLI does');
  assert.match(block, /CODEX_HOME/, 'sanity: this is the codex probe');
});

// ── execCli must be able to forward the flag ─────────────────────────────────

test('execCli accepts runtimeOptions and forwards them to the spawn', () => {
  assert.match(cliExecSource, /runtimeOptions\?: SpawnCliRuntimeOptions/);
  assert.match(cliExecSource, /getSpawnCliCache\(\), runtimeOptions\)/);
});

// ── The result is cached, and the cache is cleared on settings change ────────

test('config-dir resolution is memoized per environment and invalidatable', () => {
  assert.match(skillLoaderSource, /claudeConfigDirCache\b/);
  assert.match(skillLoaderSource, /export function invalidateClaudeConfigDirCache/);
  // Only successful probe results are cached — a fallback must be retried.
  assert.match(skillLoaderSource, /claudeConfigDirCache\.set\(environment, resolvedDir\)/);
  // The settings-change hook drops it, so a native↔wsl switch cannot go stale.
  assert.match(spawnCliSource, /invalidateClaudeConfigDirCache\(\)/);
});

// ── Behavioural: a second call returns the same answer without recomputing ───
//
// Runs on any host: whichever branch resolves the dir, calling twice must be
// stable, and invalidating must not change a stable answer. Also guards the
// CLAUDE_CONFIG_DIR early-return, which must win over any cached value.

test('repeated resolution is stable and cache-invalidation is safe', async () => {
  invalidateClaudeConfigDirCache();
  const first = await resolveClaudeConfigDirForEnvironment('native');
  const second = await resolveClaudeConfigDirForEnvironment('native');
  assert.equal(second, first, 'a cached read must equal the first read');

  invalidateClaudeConfigDirCache();
  const afterInvalidate = await resolveClaudeConfigDirForEnvironment('native');
  assert.equal(afterInvalidate, first, 'recomputation must yield the same dir');
});

test('CLAUDE_CONFIG_DIR overrides any cached value', async () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    delete process.env.CLAUDE_CONFIG_DIR;
    invalidateClaudeConfigDirCache();
    await resolveClaudeConfigDirForEnvironment('wsl'); // populate cache (fallback on non-win32)

    process.env.CLAUDE_CONFIG_DIR = '/tmp/explicit-claude-home';
    const resolved = await resolveClaudeConfigDirForEnvironment('wsl');
    assert.equal(resolved, '/tmp/explicit-claude-home',
      'an explicit CLAUDE_CONFIG_DIR must win over the cache');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    invalidateClaudeConfigDirCache();
  }
});

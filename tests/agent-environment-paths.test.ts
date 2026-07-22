import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { formatPathForAgentDisplay } from '../src/lib/filesystem/path-environment';
import { normalizeCwdForCliEnvironment } from '../src/lib/cli/spawn-cli-runtime';

const pathEnvironmentSource = fs.readFileSync(
  new URL('../src/lib/filesystem/path-environment.ts', import.meta.url),
  'utf8',
);
const memoryListRouteSource = fs.readFileSync(
  new URL('../src/app/api/sessions/[id]/memory/route.ts', import.meta.url),
  'utf8',
);
const claudeMemorySource = fs.readFileSync(
  new URL('../src/lib/memory/claude-memory.ts', import.meta.url),
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
const memoryPanelSource = fs.readFileSync(
  new URL('../src/components/memory/memory-panel.tsx', import.meta.url),
  'utf8',
);
const skillLoaderSource = fs.readFileSync(
  new URL('../src/lib/skill/skill-loader.ts', import.meta.url),
  'utf8',
);

// The `wsl` branch is platform-independent: it only rewrites path shapes the
// host uses to reach the distro, so it can be asserted on any runner.
test('a WSL session shows the paths its CLI reads, not the host UNC form', () => {
  assert.equal(
    formatPathForAgentDisplay('\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\.claude\\CLAUDE.md', 'wsl'),
    '/home/work/.claude/CLAUDE.md',
  );
  assert.equal(
    formatPathForAgentDisplay('\\\\wsl$\\Ubuntu\\home\\work\\.claude', 'wsl'),
    '/home/work/.claude',
  );
  // Windows drives are visible to the WSL CLI, but only under /mnt.
  assert.equal(
    formatPathForAgentDisplay('C:\\Users\\rs\\.claude', 'wsl'),
    '/mnt/c/Users/rs/.claude',
  );
  // Already CLI-shaped paths are left alone.
  assert.equal(formatPathForAgentDisplay('/home/work/.claude', 'wsl'), '/home/work/.claude');
});

/**
 * The paths a session shows and the cwd its CLI is spawned with have to be the
 * same string: the Claude memory folder is named after that cwd, so a display
 * path that disagrees points at a directory the agent never reads. Asserting
 * the two functions agree covers every bridge without hardcoding a host.
 */
/** Host paths a Windows-hosted server can hold: the distro share, drives, and
 *  workspace paths still stored in their distro-local form. */
const WINDOWS_HOST_PATHS = [
  '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\proj',
  '\\\\wsl$\\Ubuntu\\home\\work\\proj',
  'C:\\Users\\rs\\.claude',
  '/home/work/.claude',
];

/** Host paths a WSL-hosted server can hold: its own files, and Windows files
 *  reached through the drive mounts. */
const WSL_HOST_PATHS = [
  '/home/work/.claude',
  '/home/work/.tessera/worktrees/proj',
  '/mnt/c/Users/rs/.claude',
  '/',
];

function withPlatform(platform: NodeJS.Platform, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

function assertDisplayMatchesSpawnCwd(hostPaths: string[], label: string): void {
  for (const hostPath of hostPaths) {
    for (const environment of ['wsl', 'native'] as const) {
      assert.equal(
        formatPathForAgentDisplay(hostPath, environment),
        normalizeCwdForCliEnvironment(hostPath, environment),
        `${environment} on ${label}: ${hostPath}`,
      );
    }
  }
}

test('displayed paths match the cwd the CLI is spawned with, on every bridge', () => {
  // Windows host: 'wsl' crosses into the distro, 'native' stays put.
  withPlatform('win32', () => {
    assertDisplayMatchesSpawnCwd(WINDOWS_HOST_PATHS, 'win32');
  });

  // Linux host: 'native' crosses out to Windows, but only when the host is a
  // WSL distro — which both functions detect the same way, so this also holds
  // on a plain Linux CI runner, where both sides collapse to a no-op.
  assertDisplayMatchesSpawnCwd(WSL_HOST_PATHS, process.platform);
});

test('memory payloads carry both the host path and the CLI-visible path', () => {
  assert.match(memoryListRouteSource, /memoryDirDisplay: toMemoryDisplayPath\(/);
  assert.match(memoryListRouteSource, /instructionRootsDisplay: \{/);
  assert.match(memoryListRouteSource, /toOptionalMemoryDisplayPath\(/);
  for (const source of [claudeMemorySource, codexMemorySource, opencodeMemorySource]) {
    assert.match(source, /displayPath: toMemoryDisplayPath\(target\.absolutePath, environment\)/);
  }
});

test('the panel displays CLI paths while host actions keep the host path', () => {
  assert.match(memoryPanelSource, /title=\{row\.displayPath\}/);
  assert.match(memoryPanelSource, /displayPath: joinDisplayPath\(data\.memoryDirDisplay,/);
  assert.match(memoryPanelSource, /getDisplayDir\(globalGuidelines\[0\]\.displayPath\)/);
  assert.match(memoryPanelSource, /getDisplayDir\(projectGuidelines\[0\]\.displayPath\)/);
  // Electron opens and reveals files on the host, so those keep the host path.
  assert.match(memoryPanelSource, /absolutePath: row\.path/);
  assert.match(memoryPanelSource, /path: joinDisplayPath\(data\.memoryDir,/);
});

/**
 * Probing the Windows side from WSL goes through an outer
 * `powershell.exe -Command` wrapper (spawnWindowsNativeCliViaPowerShell), and
 * PowerShell strips double quotes when it forwards arguments to a native
 * command. A probe that quotes with `"` therefore arrives unparseable and the
 * caller silently falls back to the WSL-local directory — the agent then reads
 * a config folder no Windows CLI ever writes.
 */
function powerShellProbeScripts(source: string): string[] {
  return [...source.matchAll(/["']-Command["'],\s*(?:\/\/[^\n]*\n\s*)*("(?:[^"\\]|\\.)*")/g)]
    .map((match) => match[1]);
}

test('WSL-to-Windows probes survive PowerShell argument forwarding', () => {
  const probes = [
    ...powerShellProbeScripts(codexMemorySource),
    ...powerShellProbeScripts(opencodeMemorySource),
    ...powerShellProbeScripts(skillLoaderSource),
  ];
  assert.ok(probes.length > 0, 'expected to find PowerShell probe scripts');

  for (const probe of probes) {
    assert.doesNotMatch(probe, /\\"/, `probe must not use double quotes: ${probe}`);
    // Assigning to a PowerShell automatic variable is a silent no-op, so the
    // probe would echo the untouched built-in value instead of its own result.
    assert.doesNotMatch(
      probe,
      /\$(home|host|args|input|pwd|profile|error|matches)\s*=/i,
      `probe must not assign a PowerShell automatic variable: ${probe}`,
    );
  }
});

/** Comments explain the traps by name, so only executable code is checked. */
function withoutLineComments(source: string): string {
  return source.replace(/^[^\n'"`]*\/\/.*$/gm, '');
}

test('the Claude config dir is probed with the verified cmd.exe home lookup', () => {
  assert.match(skillLoaderSource, /environment === 'native' && isRunningInWsl\(\)/);
  assert.match(skillLoaderSource, /getWslHostedWindowsHomeMountPath\(\)/);
  assert.doesNotMatch(withoutLineComments(skillLoaderSource), /GetFolderPath/);
});

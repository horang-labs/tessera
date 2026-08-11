import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createControlCliBridgeFactory,
  type WslExecutableStore,
} from '../src/lib/control/cli-bridge';
import {
  createControlAuthorityRegistry,
  type ControlAuthorityRegistry,
} from '../src/lib/control/authority';
import { createControlHttpHandler } from '../src/lib/control/http-handler';
import {
  publishRuntimeDescriptor,
  type RuntimeDescriptorHandle,
} from '../src/lib/control/runtime-descriptor';
import { createControlService } from '../src/lib/control/service';
import { createInMemoryControlAuditHistory } from '../src/lib/control/audit';
import { runControlCli } from './helpers/control-cli-runner';

const REPO_ROOT = process.cwd();
const PACKAGE_VERSION = JSON.parse(
  fsSync.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
).version as string;

test('a native bridge stays pinned to its runtime and exact caller context', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-cli-bridge-'));
  const runtimeOne = await startRuntime(testRoot, 'one');
  const runtimeTwo = await startRuntime(testRoot, 'two');
  const factoryOne = createControlCliBridgeFactory({
    authority: runtimeOne.authority,
    runtimeId: runtimeOne.descriptor.runtimeId,
    descriptorPath: runtimeOne.path,
    cliEntryPath: path.join(REPO_ROOT, 'bin', 'tessera.mjs'),
    hostExecutablePath: process.execPath,
    hostPlatform: 'linux',
    artifactRoot: path.join(testRoot, 'bridges with spaces'),
  });
  const factoryTwo = createControlCliBridgeFactory({
    authority: runtimeTwo.authority,
    runtimeId: runtimeTwo.descriptor.runtimeId,
    descriptorPath: runtimeTwo.path,
    cliEntryPath: path.join(REPO_ROOT, 'bin', 'tessera.mjs'),
    hostExecutablePath: process.execPath,
    hostPlatform: 'linux',
    artifactRoot: path.join(testRoot, 'bridges with spaces'),
  });

  try {
    const bridgeOne = await factoryOne.create({
      agentEnvironment: 'native',
      projectId: 'project-one',
      sessionId: 'session-one',
      worktreeId: 'wt_one',
    });
    const bridgeTwo = await factoryTwo.create({
      agentEnvironment: 'native',
      projectId: 'project-two',
      sessionId: 'session-two',
    });

    assert.equal(path.isAbsolute(bridgeOne.commandPath), true);
    assert.equal(fsSync.statSync(bridgeOne.commandPath).mode & 0o111, 0o100);
    assert.deepEqual(bridgeOne.environment, {
      TESSERA_ENV: '1',
      TESSERA_CLI_COMMAND: bridgeOne.commandPath,
      TESSERA_CONTROL_AUTHORITY: bridgeOne.environment.TESSERA_CONTROL_AUTHORITY,
      TESSERA_PROJECT_ID: 'project-one',
      TESSERA_SESSION_ID: 'session-one',
      TESSERA_WORKTREE_ID: 'wt_one',
    });
    assert.match(bridgeOne.environment.TESSERA_CONTROL_AUTHORITY, /^[A-Za-z0-9_-]{43}$/);

    const resultOne = await runQuotedBridge(bridgeOne.commandPath, {
      TESSERA_CONTROL_DESCRIPTOR: runtimeTwo.path,
      TESSERA_PROJECT_ID: 'wrong-project',
      TESSERA_SESSION_ID: 'wrong-session',
      TESSERA_WORKTREE_ID: 'wrong-worktree',
    });
    assert.equal(resultOne.code, 0);
    assert.equal(resultOne.stderr, '');
    assert.deepEqual(JSON.parse(resultOne.stdout).data, {
      appVersion: PACKAGE_VERSION,
      controlVersion: 1,
      instanceId: runtimeOne.descriptor.runtimeId,
      connectionState: 'connected',
      callerContext: {
        projectId: 'project-one',
        sessionId: 'session-one',
        worktreeId: 'wt_one',
      },
    });
    for (const secret of [
      runtimeOne.path,
      runtimeTwo.path,
      runtimeOne.descriptor.token,
      runtimeTwo.descriptor.token,
      bridgeOne.environment.TESSERA_CONTROL_AUTHORITY,
      bridgeTwo.environment.TESSERA_CONTROL_AUTHORITY,
    ]) {
      assert.equal(resultOne.stdout.includes(secret), false);
      assert.equal(resultOne.stderr.includes(secret), false);
    }

    const expiredAuthority = bridgeOne.environment.TESSERA_CONTROL_AUTHORITY;
    await bridgeOne.dispose();
    assert.equal(fsSync.existsSync(bridgeOne.commandPath), false);
    assert.equal(fsSync.existsSync(bridgeTwo.commandPath), true);
    const expired = await runControlCli(
      ['status', '--json', '--control-descriptor', runtimeOne.path],
      {
        repoRoot: REPO_ROOT,
        envOverrides: { TESSERA_CONTROL_AUTHORITY: expiredAuthority },
      },
    );
    assert.equal(expired.code, 1);
    assert.equal(JSON.parse(expired.stdout).error.code, 'CONTROL_AUTHORITY_DENIED');

    const resultTwo = await runBridge(bridgeTwo.commandPath, ['status', '--json']);
    assert.equal(JSON.parse(resultTwo.stdout).data.instanceId, runtimeTwo.descriptor.runtimeId);
    assert.deepEqual(JSON.parse(resultTwo.stdout).data.callerContext, {
      projectId: 'project-two',
      sessionId: 'session-two',
    });

    await factoryTwo.dispose();
    assert.equal(fsSync.existsSync(bridgeTwo.commandPath), false);
  } finally {
    await factoryOne.dispose();
    await factoryTwo.dispose();
    await runtimeOne.cleanup();
    await runtimeTwo.cleanup();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('a Windows-to-WSL bridge exposes only a guest executable and owns both artifacts', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-wsl-cli-bridge-'));
  const guestScripts = new Map<string, string>();
  const disposedGuestPaths: string[] = [];
  const wslExecutableStore: WslExecutableStore = {
    create: async (contents) => {
      const commandPath = `/home/test/.cache/tessera/${guestScripts.size + 1}/tessera`;
      guestScripts.set(commandPath, contents);
      return commandPath;
    },
    remove: async (commandPath) => {
      disposedGuestPaths.push(commandPath);
      guestScripts.delete(commandPath);
    },
  };
  const factory = createControlCliBridgeFactory({
    authority: createControlAuthorityRegistry(),
    runtimeId: 'runtime-windows-wsl',
    descriptorPath: 'C:\\Users\\Test\\AppData\\Local\\Tessera\\runtime.json',
    cliEntryPath: 'C:\\Program Files\\Tessera\\resources\\app.asar\\bin\\tessera.mjs',
    hostExecutablePath: 'C:\\Program Files\\Tessera\\Tessera.exe',
    hostPlatform: 'win32',
    artifactRoot: testRoot,
    wslExecutableStore,
  });

  try {
    const bridge = await factory.create({
      agentEnvironment: 'wsl',
      projectId: 'project-wsl',
      sessionId: 'session-wsl',
      worktreeId: 'wt_wsl',
    });
    const guestScript = guestScripts.get(bridge.commandPath);
    assert.ok(guestScript);
    assert.match(guestScript, /^#!\/usr\/bin\/env bash/m);
    assert.match(guestScript, /TESSERA_WSL_CWD=\$\(pwd -P/);
    assert.match(guestScript, /wslpath -w "\$TESSERA_WSL_CWD"/);
    assert.match(guestScript, /powershell\.exe/);
    assert.match(guestScript, /"\$@"/);
    assert.doesNotMatch(guestScript, /runtime\.json|project-wsl|session-wsl|wt_wsl/);
    assert.deepEqual(bridge.environment, {
      TESSERA_ENV: '1',
      TESSERA_CLI_COMMAND: bridge.commandPath,
      TESSERA_CONTROL_AUTHORITY: bridge.environment.TESSERA_CONTROL_AUTHORITY,
      TESSERA_PROJECT_ID: 'project-wsl',
      TESSERA_SESSION_ID: 'session-wsl',
      TESSERA_WORKTREE_ID: 'wt_wsl',
    });

    const hostBridgePath = fsSync.readdirSync(
      path.join(testRoot, 'runtime-windows-wsl'),
      { recursive: true, encoding: 'utf8' },
    ).map(String).find((file) => file.endsWith('.ps1'));
    assert.ok(hostBridgePath);
    const hostBridge = await fs.readFile(
      path.join(testRoot, 'runtime-windows-wsl', hostBridgePath),
      'utf8',
    );
    assert.match(hostBridge, /--control-descriptor/);
    assert.match(hostBridge, /TESSERA_AGENT_ENVIRONMENT.*wsl/);
    assert.match(hostBridge, /TESSERA_PROJECT_ID.*project-wsl/);
    assert.match(hostBridge, /TESSERA_SESSION_ID.*session-wsl/);
    assert.match(hostBridge, /TESSERA_WORKTREE_ID.*wt_wsl/);
    assert.match(hostBridge, /TESSERA_CLI_CWD/);
    assert.match(hostBridge, /TESSERA_CLI_WSL_DISTRO/);
    assert.match(hostBridge, /@cliArgs \| ForEach-Object \{ Write-Output \$_ \}/);
    assert.doesNotMatch(hostBridge, /Bearer|authorization/i);

    await bridge.dispose();
    assert.deepEqual(disposedGuestPaths, [bridge.commandPath]);
    assert.equal(guestScripts.has(bridge.commandPath), false);
    assert.equal(fsSync.existsSync(path.dirname(path.join(
      testRoot,
      'runtime-windows-wsl',
      hostBridgePath,
    ))), false);
  } finally {
    await factory.dispose();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('the host CLI resolves WSL file inputs from the exact caller context', async () => {
  const { resolveCallerFilePath } = await import('../bin/control-cli.mjs');
  const translated: string[] = [];
  const env = {
    TESSERA_AGENT_ENVIRONMENT: 'wsl',
    TESSERA_CLI_CWD: 'C:\\caller cwd',
    TESSERA_CLI_WSL_DISTRO: 'Ubuntu-24.04',
  };

  assert.equal(
    await resolveCallerFilePath('prompt file.txt', env, { platform: 'win32' }),
    'C:\\caller cwd\\prompt file.txt',
  );
  assert.equal(
    await resolveCallerFilePath('/home/test/prompt.txt', env, {
      platform: 'win32',
      translateWslPath: async (inputPath: string, distroName: string | undefined) => {
        translated.push(`${distroName}:${inputPath}`);
        return '\\\\wsl.localhost\\Ubuntu-24.04\\home\\test\\prompt.txt';
      },
    }),
    '\\\\wsl.localhost\\Ubuntu-24.04\\home\\test\\prompt.txt',
  );
  assert.deepEqual(translated, ['Ubuntu-24.04:/home/test/prompt.txt']);
  assert.equal(
    await resolveCallerFilePath('prompt file.txt', env, { platform: 'linux' }),
    'prompt file.txt',
  );
});

test('runtime cleanup waits for a guest bridge disposal already in flight', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-wsl-cleanup-'));
  let reportRemoveStarted!: () => void;
  let releaseRemove!: () => void;
  const removeStarted = new Promise<void>((resolve) => { reportRemoveStarted = resolve; });
  const removeGate = new Promise<void>((resolve) => { releaseRemove = resolve; });
  const factory = createControlCliBridgeFactory({
    authority: createControlAuthorityRegistry(),
    runtimeId: 'runtime-cleanup-race',
    descriptorPath: 'C:\\private\\runtime.json',
    cliEntryPath: 'C:\\Tessera\\bin\\tessera.mjs',
    hostExecutablePath: 'C:\\Tessera\\Tessera.exe',
    hostPlatform: 'win32',
    artifactRoot: testRoot,
    wslExecutableStore: {
      create: async () => '/home/test/.cache/tessera/bridge/tessera',
      remove: async () => {
        reportRemoveStarted();
        await removeGate;
      },
    },
  });
  const bridge = await factory.create({
    agentEnvironment: 'wsl',
    projectId: 'project-cleanup',
    sessionId: 'session-cleanup',
  });

  const bridgeDisposal = bridge.dispose();
  await removeStarted;
  let factorySettled = false;
  const factoryDisposal = factory.dispose().then(() => { factorySettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(factorySettled, false);

  releaseRemove();
  await Promise.all([bridgeDisposal, factoryDisposal]);
  assert.equal(fsSync.existsSync(path.join(testRoot, 'runtime-cleanup-race')), false);
  await fs.rm(testRoot, { recursive: true, force: true });
});

test('runtime cleanup cancels and removes a guest bridge creation already in flight', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-wsl-create-race-'));
  let reportCreateStarted!: () => void;
  let releaseCreate!: () => void;
  const createStarted = new Promise<void>((resolve) => { reportCreateStarted = resolve; });
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const removedGuestPaths: string[] = [];
  const factory = createControlCliBridgeFactory({
    authority: createControlAuthorityRegistry(),
    runtimeId: 'runtime-create-race',
    descriptorPath: 'C:\\private\\runtime.json',
    cliEntryPath: 'C:\\Tessera\\bin\\tessera.mjs',
    hostExecutablePath: 'C:\\Tessera\\Tessera.exe',
    hostPlatform: 'win32',
    artifactRoot: testRoot,
    wslExecutableStore: {
      create: async () => {
        reportCreateStarted();
        await createGate;
        return '/home/test/.cache/tessera/create-race/tessera';
      },
      remove: async (commandPath) => { removedGuestPaths.push(commandPath); },
    },
  });

  const bridgeCreation = factory.create({
    agentEnvironment: 'wsl',
    projectId: 'project-create-race',
    sessionId: 'session-create-race',
  });
  await createStarted;
  const factoryDisposal = factory.dispose();
  releaseCreate();

  await assert.rejects(bridgeCreation, /bridge factory is closed/i);
  await factoryDisposal;
  assert.deepEqual(removedGuestPaths, ['/home/test/.cache/tessera/create-race/tessera']);
  assert.equal(fsSync.existsSync(path.join(testRoot, 'runtime-create-race')), false);
  await fs.rm(testRoot, { recursive: true, force: true });
});

test('runtime cleanup reports and retries a failed guest artifact removal', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-wsl-remove-retry-'));
  let removeAttempts = 0;
  const factory = createControlCliBridgeFactory({
    authority: createControlAuthorityRegistry(),
    runtimeId: 'runtime-remove-retry',
    descriptorPath: 'C:\\private\\runtime.json',
    cliEntryPath: 'C:\\Tessera\\bin\\tessera.mjs',
    hostExecutablePath: 'C:\\Tessera\\Tessera.exe',
    hostPlatform: 'win32',
    artifactRoot: testRoot,
    wslExecutableStore: {
      create: async () => '/home/test/.cache/tessera/remove-retry/tessera',
      remove: async () => {
        removeAttempts += 1;
        if (removeAttempts === 1) throw new Error('guest filesystem offline');
      },
    },
  });
  const bridge = await factory.create({
    agentEnvironment: 'wsl',
    projectId: 'project-remove-retry',
    sessionId: 'session-remove-retry',
  });

  await assert.rejects(bridge.dispose(), /guest filesystem offline/);
  await factory.dispose();
  assert.equal(removeAttempts, 2);
  assert.equal(fsSync.existsSync(path.join(testRoot, 'runtime-remove-retry')), false);
  await fs.rm(testRoot, { recursive: true, force: true });
});

test('the generated WSL executable crosses into a host process with cwd and context intact', {
  skip: !process.env.WSL_DISTRO_NAME || !fsSync.existsSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'),
}, async () => {
  const windowsTemp = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', '[System.IO.Path]::GetTempPath()'],
    { encoding: 'utf8' },
  ).trim();
  const windowsTempInWsl = execFileSync('wslpath', ['-u', windowsTemp], {
    encoding: 'utf8',
  }).trim();
  const testRoot = await fs.mkdtemp(path.join(windowsTempInWsl, 'tessera-wsl-exec-'));
  const invocationCwd = path.join(testRoot, 'caller cwd');
  await fs.mkdir(invocationCwd);
  await fs.writeFile(path.join(invocationCwd, 'prompt file.txt'), 'bridge prompt');
  const fakeCliPath = path.join(testRoot, 'fake-host-cli.cjs');
  await fs.writeFile(fakeCliPath, [
    "const fs = require('node:fs');",
    'const keys = [',
    "  'TESSERA_ENV', 'TESSERA_AGENT_ENVIRONMENT', 'TESSERA_PROJECT_ID', 'TESSERA_SESSION_ID',",
    "  'TESSERA_WORKTREE_ID', 'TESSERA_CLI_CWD', 'TESSERA_CLI_WSL_DISTRO', 'TESSERA_CONTROL_DESCRIPTOR',",
    '];',
    "let stdin = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { stdin += chunk; });",
    "process.stdin.on('end', () => {",
    'const argv = process.argv.slice(2);',
    "const promptFileIndex = argv.indexOf('--prompt-file');",
    "const promptInput = promptFileIndex === -1 ? null : argv[promptFileIndex + 1] === '-'",
    '  ? stdin',
    "  : fs.readFileSync(argv[promptFileIndex + 1], 'utf8');",
    'console.log(JSON.stringify({',
    '  argv,',
    '  env: Object.fromEntries(keys.map((key) => [key, process.env[key]])),',
    '  stdin,',
    '  promptInput,',
    '}));',
    '});',
    '',
  ].join('\n'));
  const windowsNode = execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    '(Get-Command node.exe).Source',
  ], {
    encoding: 'utf8',
  }).trim();
  assert.ok(windowsNode);
  const toWindowsPath = (hostPath: string) => execFileSync('wslpath', ['-w', hostPath], {
    encoding: 'utf8',
  }).trim();
  const factory = createControlCliBridgeFactory({
    authority: createControlAuthorityRegistry(),
    runtimeId: 'runtime-real-wsl-boundary',
    descriptorPath: 'C:\\private\\exact-runtime.json',
    cliEntryPath: toWindowsPath(fakeCliPath),
    hostExecutablePath: windowsNode,
    hostPlatform: 'win32',
    artifactRoot: path.join(testRoot, 'host-artifacts'),
    formatHostPathForWsl: toWindowsPath,
  });

  try {
    const bridge = await factory.create({
      agentEnvironment: 'wsl',
      projectId: 'project-real-wsl',
      sessionId: 'session-real-wsl',
      worktreeId: 'wt_real_wsl',
    });
    const result = await runBridge(
      bridge.commandPath,
      ['status', '--json', 'argument with spaces', '--file', 'prompt file.txt'],
      bridge.environment as Record<string, string>,
      invocationCwd,
    );
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    const received = JSON.parse(result.stdout);
    assert.deepEqual(received.argv, [
      '--control-descriptor',
      'C:\\private\\exact-runtime.json',
      'status',
      '--json',
      'argument with spaces',
      '--file',
      'prompt file.txt',
    ]);
    assert.deepEqual(received.env, {
      TESSERA_ENV: '1',
      TESSERA_AGENT_ENVIRONMENT: 'wsl',
      TESSERA_PROJECT_ID: 'project-real-wsl',
      TESSERA_SESSION_ID: 'session-real-wsl',
      TESSERA_WORKTREE_ID: 'wt_real_wsl',
      TESSERA_CLI_CWD: toWindowsPath(invocationCwd),
      TESSERA_CLI_WSL_DISTRO: process.env.WSL_DISTRO_NAME,
    });
    assert.equal(received.stdin, '');
    assert.equal(received.promptInput, null);
    assert.equal(result.stdout.includes('Bearer'), false);

    const waited = await runBridge(
      bridge.commandPath,
      ['session', 'wait', 'session-child', '--for', 'turn-complete', '--timeout', '1', '--json'],
      bridge.environment as Record<string, string>,
      invocationCwd,
    );
    assert.equal(waited.code, 0, waited.stderr || waited.stdout);
    assert.equal(waited.stderr, '');
    assert.deepEqual(JSON.parse(waited.stdout).argv, [
      '--control-descriptor',
      'C:\\private\\exact-runtime.json',
      'session',
      'wait',
      'session-child',
      '--for',
      'turn-complete',
      '--timeout',
      '1',
      '--json',
    ]);

    const pipedInput = 'first line\nsecond line 🧩\n';
    const piped = await runBridge(
      bridge.commandPath,
      ['session', 'launch', '--prompt-file', '-', '--json'],
      bridge.environment as Record<string, string>,
      invocationCwd,
      pipedInput,
    );
    assert.equal(piped.code, 0, piped.stderr || piped.stdout);
    assert.equal(piped.stderr, '');
    const receivedPiped = JSON.parse(piped.stdout);
    assert.deepEqual(receivedPiped.argv.slice(0, 5), [
      '--control-descriptor',
      'C:\\private\\exact-runtime.json',
      'session',
      'launch',
      '--prompt-file',
    ]);
    assert.equal(path.win32.isAbsolute(receivedPiped.argv[5]), true);
    assert.equal(receivedPiped.argv[6], '--json');
    assert.equal(receivedPiped.stdin, '');
    assert.equal(receivedPiped.promptInput, pipedInput);
  } finally {
    await factory.dispose();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('a Windows GUI host exit code survives the WSL bridge', {
  skip: !process.env.WSL_DISTRO_NAME || !fsSync.existsSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'),
}, async () => {
  const windowsTemp = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', '[System.IO.Path]::GetTempPath()'],
    { encoding: 'utf8' },
  ).trim();
  const windowsTempInWsl = execFileSync('wslpath', ['-u', windowsTemp], {
    encoding: 'utf8',
  }).trim();
  const testRoot = await fs.mkdtemp(path.join(windowsTempInWsl, 'tessera-wsl-gui-exit-'));
  const fakeCliPath = path.join(testRoot, 'exit-23.vbs');
  await fs.writeFile(fakeCliPath, 'WScript.Quit 23\r\n');
  const windowsScriptHost = execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    '(Get-Command wscript.exe).Source',
  ], {
    encoding: 'utf8',
  }).trim();
  const toWindowsPath = (hostPath: string) => execFileSync('wslpath', ['-w', hostPath], {
    encoding: 'utf8',
  }).trim();
  const factory = createControlCliBridgeFactory({
    authority: createControlAuthorityRegistry(),
    runtimeId: 'runtime-real-wsl-gui-exit',
    descriptorPath: 'C:\\private\\exact-runtime.json',
    cliEntryPath: toWindowsPath(fakeCliPath),
    hostExecutablePath: windowsScriptHost,
    hostPlatform: 'win32',
    artifactRoot: path.join(testRoot, 'host-artifacts'),
    formatHostPathForWsl: toWindowsPath,
  });

  try {
    const bridge = await factory.create({
      agentEnvironment: 'wsl',
      projectId: 'project-real-wsl',
      sessionId: 'session-real-wsl',
    });
    const result = await runBridge(
      bridge.commandPath,
      ['status', '--json'],
      bridge.environment as Record<string, string>,
      testRoot,
    );
    assert.equal(result.code, 23, result.stderr || result.stdout);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    await factory.dispose();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

async function startRuntime(
  testRoot: string,
  label: string,
): Promise<RuntimeDescriptorHandle & { authority: ControlAuthorityRegistry }> {
  let requestHandler: ReturnType<typeof createControlHttpHandler> | undefined;
  const server = http.createServer((request, response) => {
    if (!requestHandler) {
      response.writeHead(503).end();
      return;
    }
    void requestHandler(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const descriptor = await publishRuntimeDescriptor({
    appVersion: PACKAGE_VERSION,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    runtimeDirectory: path.join(testRoot, label),
  });
  const authority = createControlAuthorityRegistry();
  requestHandler = createControlHttpHandler({
    descriptor: descriptor.descriptor,
    service: createControlService({
      appVersion: PACKAGE_VERSION,
      runtimeId: descriptor.descriptor.runtimeId,
      authority,
      auditHistory: createInMemoryControlAuditHistory(),
      projects: { list: () => [], get: () => undefined },
      worktrees: { list: () => [], get: () => undefined },
    }),
  });
  const cleanupDescriptor = descriptor.cleanup;
  return {
    ...descriptor,
    authority,
    cleanup: async () => {
      await cleanupDescriptor();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function runBridge(
  commandPath: string,
  args: string[],
  envOverrides: Record<string, string> = {},
  cwd = REPO_ROOT,
  stdin?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(commandPath, args, {
      cwd,
      env: { ...process.env, ...envOverrides },
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(stdin);
  });
}

function runQuotedBridge(
  commandPath: string,
  envOverrides: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runBridge('sh', ['-c', '"$TESSERA_CLI_COMMAND" status --json'], {
    ...envOverrides,
    TESSERA_CLI_COMMAND: commandPath,
  });
}

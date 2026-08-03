import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createControlHttpHandler } from '../src/lib/control/http-handler';
import {
  publishRuntimeDescriptor,
  type RuntimeDescriptorHandle,
} from '../src/lib/control/runtime-descriptor';
import { createControlService } from '../src/lib/control/service';

const REPO_ROOT = process.cwd();
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'tessera.mjs');
const PACKAGE_VERSION = JSON.parse(
  fsSync.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
).version as string;

interface TestRuntime {
  descriptor: RuntimeDescriptorHandle;
  close(): Promise<void>;
}

test('the CLI stays pinned to one of two distinguishable runtimes and their Projects', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-control-cli-'));
  const runtimeOne = await startRuntime(testRoot, 'one', {
    id: '/home/work/project-one',
    decodedPath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\project-one',
    displayName: 'Project One',
    visible: true,
  });
  const runtimeTwo = await startRuntime(testRoot, 'two', {
    id: '/home/work/project-two',
    decodedPath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\project-two',
    displayName: 'Project Two',
    visible: false,
  });

  try {
    const statusOne = await runCli([
      'status', '--json', '--control-descriptor', runtimeOne.descriptor.path,
    ]);
    const statusTwo = await runCli([
      'status', '--json', '--control-descriptor', runtimeTwo.descriptor.path,
    ]);

    assert.equal(statusOne.code, 0);
    assert.equal(statusTwo.code, 0);
    assert.equal(statusOne.stderr, '');
    assert.equal(statusTwo.stderr, '');
    assert.equal(JSON.parse(statusOne.stdout).data.instanceId, runtimeOne.descriptor.descriptor.runtimeId);
    assert.equal(JSON.parse(statusTwo.stdout).data.instanceId, runtimeTwo.descriptor.descriptor.runtimeId);
    assert.notEqual(JSON.parse(statusOne.stdout).data.instanceId, JSON.parse(statusTwo.stdout).data.instanceId);

    const listOne = await runCli([
      'project', 'list', '--json', '--control-descriptor', runtimeOne.descriptor.path,
    ]);
    assert.deepEqual(JSON.parse(listOne.stdout).data.projects.map((project: { id: string }) => project.id), [
      '/home/work/project-one',
    ]);
    assert.equal(listOne.stdout.trim().split('\n').length, 1);

    const showTwo = await runCli([
      'project', 'show', '/home/work/project-two', '--json',
      '--control-descriptor', runtimeTwo.descriptor.path,
    ]);
    assert.equal(showTwo.code, 0);
    assert.deepEqual(JSON.parse(showTwo.stdout).data, {
      id: '/home/work/project-two',
      displayName: 'Project Two',
      path: '/home/work/project-two',
      visible: false,
      agentEnvironmentCompatibility: {
        agentEnvironment: 'wsl',
        filesystemKind: 'wsl',
        compatible: true,
      },
    });

    for (const output of [statusOne, statusTwo, listOne, showTwo]) {
      assert.equal(output.stdout.includes(runtimeOne.descriptor.descriptor.token), false);
      assert.equal(output.stdout.includes(runtimeTwo.descriptor.descriptor.token), false);
      assert.equal(output.stdout.includes(testRoot), false);
      assert.equal(output.stderr.includes(testRoot), false);
    }
  } finally {
    await runtimeOne.close();
    await runtimeTwo.close();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('the CLI uses stable JSON failures and process exits', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-control-cli-errors-'));
  const runtime = await startRuntime(testRoot, 'errors', {
    id: 'project-present',
    decodedPath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\project-present',
    displayName: 'Present',
    visible: true,
  });

  try {
    const missingProject = await runCli([
      'project', 'show', 'project-missing', '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(missingProject.code, 1);
    assert.equal(JSON.parse(missingProject.stdout).error.code, 'PROJECT_NOT_FOUND');

    const invalidUsage = await runCli([
      'project', 'show', '--json', '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(invalidUsage.code, 2);
    assert.equal(JSON.parse(invalidUsage.stdout).error.code, 'INVALID_USAGE');

    const malformedSelector = await runCli([
      '--control-descriptor', 'status', '--json',
    ]);
    assert.equal(malformedSelector.code, 2);
    assert.equal(JSON.parse(malformedSelector.stdout).error.code, 'INVALID_USAGE');
    assert.equal(malformedSelector.stdout.trim().split('\n').length, 1);

    const missingSelectorValue = await runCli([
      '--control-descriptor', '--json', 'status',
    ]);
    assert.equal(missingSelectorValue.code, 2);
    assert.equal(JSON.parse(missingSelectorValue.stdout).error.code, 'INVALID_USAGE');
    assert.equal(missingSelectorValue.stdout.trim().split('\n').length, 1);

    const unavailable = await runCli([
      'status', '--json', '--control-descriptor', path.join(testRoot, 'missing.json'),
    ]);
    assert.equal(unavailable.code, 1);
    assert.equal(JSON.parse(unavailable.stdout).error.code, 'INSTANCE_UNAVAILABLE');
    assert.equal(unavailable.stdout.includes(testRoot), false);
    assert.equal(unavailable.stderr.includes(testRoot), false);

    const incompatiblePath = path.join(path.dirname(runtime.descriptor.path), 'incompatible.json');
    await writeDescriptorVariant(runtime.descriptor, incompatiblePath, { appVersion: '9.9.9' });
    const incompatible = await runCli([
      'status', '--json', '--control-descriptor', incompatiblePath,
    ]);
    assert.equal(incompatible.code, 1);
    assert.equal(JSON.parse(incompatible.stdout).error.code, 'CONTROL_VERSION_MISMATCH');

    const incompatibleControlPath = path.join(
      path.dirname(runtime.descriptor.path),
      'incompatible-control.json',
    );
    await writeDescriptorVariant(runtime.descriptor, incompatibleControlPath, {
      controlApiVersion: 2,
    });
    const incompatibleControl = await runCli([
      'status', '--json', '--control-descriptor', incompatibleControlPath,
    ]);
    assert.equal(incompatibleControl.code, 1);
    assert.equal(JSON.parse(incompatibleControl.stdout).error.code, 'CONTROL_VERSION_MISMATCH');

    const unauthorizedPath = path.join(path.dirname(runtime.descriptor.path), 'unauthorized.json');
    await writeDescriptorVariant(runtime.descriptor, unauthorizedPath, {
      token: Buffer.alloc(32, 9).toString('base64url'),
    });
    const unauthorized = await runCli([
      'status', '--json', '--control-descriptor', unauthorizedPath,
    ]);
    assert.equal(unauthorized.code, 1);
    assert.equal(JSON.parse(unauthorized.stdout).error.code, 'UNAUTHORIZED');
  } finally {
    await runtime.close();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('server startup help and version behavior remain available without a Control command', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Starts the local Tessera web UI server\./);
  assert.match(help.stdout, /tessera project show <project-id>/);

  const version = await runCli(['--version']);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), PACKAGE_VERSION);

  const controlHelp = await runCli(['status', '--help']);
  assert.equal(controlHelp.code, 0);
  assert.match(controlHelp.stdout, /--control-descriptor PATH/);
  assert.equal(controlHelp.stderr, '');

  const jsonControlHelp = await runCli(['status', '--json', '--help']);
  assert.equal(jsonControlHelp.code, 0);
  const jsonHelpEnvelope = JSON.parse(jsonControlHelp.stdout);
  assert.equal(jsonHelpEnvelope.ok, true);
  assert.match(jsonHelpEnvelope.data.usage, /--control-descriptor PATH/);
  assert.equal(jsonControlHelp.stdout.trim().split('\n').length, 1);
  assert.equal(jsonControlHelp.stderr, '');
});

async function startRuntime(
  testRoot: string,
  label: string,
  project: { id: string; decodedPath: string; displayName: string; visible: boolean },
): Promise<TestRuntime> {
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
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const descriptor = await publishRuntimeDescriptor({
    appVersion: PACKAGE_VERSION,
    origin,
    runtimeDirectory: path.join(testRoot, label),
  });
  const service = createControlService({
    appVersion: PACKAGE_VERSION,
    runtimeId: descriptor.descriptor.runtimeId,
    projects: {
      list: () => [project],
      get: (projectId) => projectId === project.id ? project : undefined,
    },
  });
  requestHandler = createControlHttpHandler({ descriptor: descriptor.descriptor, service });

  return {
    descriptor,
    close: async () => {
      await descriptor.cleanup();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function writeDescriptorVariant(
  handle: RuntimeDescriptorHandle,
  destination: string,
  patch: Omit<Partial<RuntimeDescriptorHandle['descriptor']>, 'controlApiVersion'> & {
    controlApiVersion?: number;
  },
): Promise<void> {
  await fs.writeFile(destination, JSON.stringify({ ...handle.descriptor, ...patch }), { mode: 0o600 });
  await fs.chmod(destination, 0o600);
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TESSERA_AGENT_ENVIRONMENT: 'wsl',
        TESSERA_CONTROL_DESCRIPTOR: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

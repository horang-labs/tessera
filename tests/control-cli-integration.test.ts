import assert from 'node:assert/strict';
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
import {
  ControlOperationError,
  ControlWorktreeCreationError,
  type ControlSessionRecord,
  type ControlWorktreeRecord,
} from '../src/lib/control/service';
import { toControlLaunchError } from '../src/lib/control/session-launch-errors';
import { ProviderLaunchError } from '../src/lib/terminal/provider-launch-module';
import { runControlCli } from './helpers/control-cli-runner';

const REPO_ROOT = process.cwd();
const PACKAGE_VERSION = JSON.parse(
  fsSync.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
).version as string;

interface TestRuntime {
  descriptor: RuntimeDescriptorHandle;
  sessionStarts: Array<{ sessionId: string; initialPrompt?: string; allowPreparationFailure?: boolean }>;
  sessionWaits: Array<{ sessionId: string; condition: string; timeoutMs: number }>;
  sessionControls: Array<{ sessionId: string; kind: string; value?: unknown }>;
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

test('the CLI lists and shows zero-session Worktrees through exact selectors', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-control-worktrees-'));
  const project = {
    id: 'project-worktrees',
    decodedPath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\project-worktrees',
    displayName: 'Project Worktrees',
    visible: true,
  };
  const worktrees: ControlWorktreeRecord[] = [{
    worktreeId: 'wt_zero_session',
    projectId: project.id,
    title: 'Zero session',
    branch: 'feature/zero-session',
    filesystemPath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\zero-session',
    preparationStatus: 'never_run',
    preparationPhase: 'before',
    sessions: [],
  }];
  const runtime = await startRuntime(testRoot, 'worktrees', project, worktrees);

  try {
    const byCurrent = await runCli([
      'worktree', 'list', '--current', '--json',
      '--control-descriptor', runtime.descriptor.path,
    ], { TESSERA_PROJECT_ID: project.id });
    assert.equal(byCurrent.code, 0);
    assert.equal(JSON.parse(byCurrent.stdout).data.worktrees[0].path, '/home/work/zero-session');
    assert.deepEqual(JSON.parse(byCurrent.stdout).data.worktrees[0].sessions, []);

    const byProject = await runCli([
      'worktree', 'list', '--project', project.id, '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(byProject.code, 0);
    assert.equal(JSON.parse(byProject.stdout).data.worktrees[0].worktreeId, 'wt_zero_session');

    const nativeShow = await runCli([
      'worktree', 'show', 'wt_zero_session', '--json',
      '--control-descriptor', runtime.descriptor.path,
    ], { TESSERA_AGENT_ENVIRONMENT: 'native' });
    assert.equal(nativeShow.code, 0);
    assert.equal(
      JSON.parse(nativeShow.stdout).data.path,
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\zero-session',
    );

    const missingSelector = await runCli([
      'worktree', 'list', '--json', '--control-descriptor', runtime.descriptor.path,
    ]);
    const duplicateSelector = await runCli([
      'worktree', 'list', '--current', '--project', project.id, '--json',
      '--control-descriptor', runtime.descriptor.path,
    ], { TESSERA_PROJECT_ID: project.id });
    assert.equal(missingSelector.code, 2);
    assert.equal(duplicateSelector.code, 2);

    const currentWithoutContext = await runCli([
      'worktree', 'list', '--current', '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(currentWithoutContext.code, 1);
    assert.equal(JSON.parse(currentWithoutContext.stdout).error.code, 'CALLER_CONTEXT_UNAVAILABLE');

    const legacyId = await runCli([
      'worktree', 'show', 'legacy-internal-id', '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(legacyId.code, 1);
    assert.equal(JSON.parse(legacyId.stdout).error.code, 'WORKTREE_NOT_FOUND');
  } finally {
    await runtime.close();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('the CLI creates a zero-session Worktree from exact explicit Git inputs', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-control-worktree-create-'));
  const project = {
    id: 'project-create',
    decodedPath: '/repo/project-create',
    displayName: 'Project Create',
    visible: true,
  };
  const worktrees: ControlWorktreeRecord[] = [];
  const runtime = await startRuntime(testRoot, 'create', project, worktrees);

  try {
    const created = await runCli([
      'worktree', 'create', '--current', '-b', 'feature/exact-branch',
      'origin/main', '--json', '--control-descriptor', runtime.descriptor.path,
    ], { TESSERA_PROJECT_ID: project.id });

    assert.equal(created.code, 0);
    assert.equal(created.stderr, '');
    assert.deepEqual(JSON.parse(created.stdout).data, {
      worktreeId: 'wt_created_1',
      projectId: project.id,
      title: 'feature/exact-branch',
      branch: 'feature/exact-branch',
      startPoint: 'origin/main',
      path: '/worktrees/feature/exact-branch',
      preparation: {
        status: 'succeeded',
        phase: 'before',
        afterRunning: false,
      },
      sessions: [],
    });

    const invalidInvocations = [
      ['worktree', 'create', '--project', project.id, 'main'],
      ['worktree', 'create', '--project', project.id, '-b', 'feature/missing-start'],
      ['worktree', 'create', '--current', '--project', project.id, '-b', 'feature/two-selectors', 'main'],
      ['worktree', 'create', '--project', project.id, '-b', 'feature/one', '--branch', 'feature/two', 'main'],
      ['worktree', 'create', '--project', project.id, '-b', 'feature/two-starts', 'main', 'origin/main'],
      ['worktree', 'create', '--project', project.id, '-b', 'feature/path', 'main', '--path', '/tmp/caller'],
    ];
    for (const args of invalidInvocations) {
      const invalid = await runCli([
        ...args, '--json', '--control-descriptor', runtime.descriptor.path,
      ], { TESSERA_PROJECT_ID: project.id });
      assert.equal(invalid.code, 2, args.join(' '));
      assert.equal(JSON.parse(invalid.stdout).error.code, 'INVALID_USAGE');
    }

    const createdCount = worktrees.length;
    const currentWithoutContext = await runCli([
      'worktree', 'create', '--current', '-b', 'feature/no-context', 'main',
      '--json', '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(currentWithoutContext.code, 1);
    assert.equal(JSON.parse(currentWithoutContext.stdout).error.code, 'CALLER_CONTEXT_UNAVAILABLE');
    assert.equal(worktrees.length, createdCount);

    const timedOut = await runCli([
      'worktree', 'create', '--project', project.id, '-b', 'feature/prep-timeout', 'main',
      '--json', '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(timedOut.code, 124);
    const timeoutEnvelope = JSON.parse(timedOut.stdout);
    assert.equal(timeoutEnvelope.error.code, 'PREPARATION_TIMEOUT');
    assert.equal(timeoutEnvelope.error.details.worktree.branch, 'feature/prep-timeout');
    assert.deepEqual(timeoutEnvelope.error.details.worktree.sessions, []);
  } finally {
    await runtime.close();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('the CLI creates, starts, launches, lists, and shows detached Sessions with exact prompt choices', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-control-session-cli-'));
  const project = {
    id: 'project-sessions',
    decodedPath: '/repo/project-sessions',
    displayName: 'Project Sessions',
    visible: true,
  };
  const worktree: ControlWorktreeRecord = {
    worktreeId: 'wt_sessions',
    projectId: project.id,
    title: 'Session Worktree',
    branch: 'feature/sessions',
    filesystemPath: '/worktrees/sessions',
    preparationStatus: 'succeeded',
    preparationPhase: 'before',
    sessions: [],
  };
  const promptFile = path.join(testRoot, 'prompt.txt');
  const oversizedPromptFile = path.join(testRoot, 'oversized-prompt.txt');
  await fs.writeFile(promptFile, '-inspect\nthis checkout');
  await fs.writeFile(oversizedPromptFile, 'x'.repeat(16_385));
  const runtime = await startRuntime(testRoot, 'sessions', project, [worktree]);

  try {
    const created = await runCli([
      'session', 'create', '--worktree', worktree.worktreeId,
      '--provider', 'codex', '--title', 'Created only',
      '--model', 'gpt-5.6-sol', '--effort', 'high', '--fast', '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(created.code, 0, created.stderr || created.stdout);
    const createdSession = JSON.parse(created.stdout).data;
    assert.equal(createdSession.worktreeId, worktree.worktreeId);
    assert.equal(createdSession.provider, 'codex');
    assert.equal(createdSession.model, 'gpt-5.6-sol');
    assert.equal(createdSession.reasoningEffort, 'high');
    assert.equal(createdSession.serviceTier, 'fast');
    assert.equal(Object.hasOwn(createdSession, 'providerState'), false);

    const started = await runCli([
      'session', 'start', createdSession.sessionId,
      '--prompt-file', promptFile, '--allow-preparation-failure', '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(started.code, 0, started.stderr || started.stdout);
    assert.deepEqual(runtime.sessionStarts[0], {
      sessionId: createdSession.sessionId,
      initialPrompt: '-inspect\nthis checkout',
      allowPreparationFailure: true,
    });

    const launched = await runCli([
      'session', 'launch', '--worktree', worktree.worktreeId,
      '--provider', 'opencode', '--no-prompt', '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(launched.code, 0, launched.stderr || launched.stdout);
    assert.equal(runtime.sessionStarts[1]?.initialPrompt, undefined);

    const optionLikePrompt = await runCli([
      'session', 'launch', '--worktree', worktree.worktreeId,
      '--provider', 'claude-code', '--model', 'claude-opus-4-8', '--effort', 'max',
      '--prompt', '--json',
      '--json', '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(optionLikePrompt.code, 0, optionLikePrompt.stderr || optionLikePrompt.stdout);
    assert.equal(JSON.parse(optionLikePrompt.stdout).data.session.model, 'claude-opus-4-8');
    assert.equal(JSON.parse(optionLikePrompt.stdout).data.session.reasoningEffort, 'max');
    assert.equal(runtime.sessionStarts[2]?.initialPrompt, '--json');

    const literalTerminatorPrompt = await runCli([
      'session', 'launch', '--worktree', worktree.worktreeId,
      '--provider', 'codex', '--no-fast', '--prompt', '--', '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    const reorderedLiteralTerminatorPrompt = await runCli([
      '--json', '--control-descriptor', runtime.descriptor.path,
      'session', 'launch', '--worktree', worktree.worktreeId,
      '--provider', 'codex', '--prompt', '--',
    ]);
    assert.equal(
      literalTerminatorPrompt.code,
      0,
      literalTerminatorPrompt.stderr || literalTerminatorPrompt.stdout,
    );
    assert.equal(
      reorderedLiteralTerminatorPrompt.code,
      0,
      reorderedLiteralTerminatorPrompt.stderr || reorderedLiteralTerminatorPrompt.stdout,
    );
    assert.equal(runtime.sessionStarts[3]?.initialPrompt, '--');
    assert.equal(JSON.parse(literalTerminatorPrompt.stdout).data.session.serviceTier, 'default');
    assert.equal(runtime.sessionStarts[4]?.initialPrompt, '--');

    const listed = await runCli([
      'session', 'list', '--worktree', worktree.worktreeId, '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(listed.code, 0);
    assert.deepEqual(
      JSON.parse(listed.stdout).data.sessions.map((session: { sessionId: string }) => session.sessionId),
      [
        createdSession.sessionId,
        JSON.parse(launched.stdout).data.session.sessionId,
        JSON.parse(optionLikePrompt.stdout).data.session.sessionId,
        JSON.parse(literalTerminatorPrompt.stdout).data.session.sessionId,
        JSON.parse(reorderedLiteralTerminatorPrompt.stdout).data.session.sessionId,
      ],
    );

    const shown = await runCli([
      'session', 'show', createdSession.sessionId, '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(shown.code, 0);
    assert.equal(JSON.parse(shown.stdout).data.sessionId, createdSession.sessionId);

    const read = await runCli([
      'session', 'read', createdSession.sessionId, '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(read.code, 0, read.stderr || read.stdout);
    assert.deepEqual(JSON.parse(read.stdout).data, {
      screen: 'unique detached output',
      cols: 100,
      rows: 30,
      alternateScreen: false,
      outputSequence: 9,
      terminalId: 'terminal-observed',
      runtimeState: 'turn-complete',
      stateAt: 4000,
      lifecyclePreview: 'provider response boundary',
    });

    const waited = await runCli([
      'session', 'wait', createdSession.sessionId,
      '--for', 'turn-complete', '--timeout', '12', '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(waited.code, 0, waited.stderr || waited.stdout);
    assert.equal(JSON.parse(waited.stdout).data.runtimeState, 'turn-complete');

    const defaultWait = await runCli([
      'session', 'wait', createdSession.sessionId,
      '--for', 'turn-complete', '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(defaultWait.code, 0, defaultWait.stderr || defaultWait.stdout);
    assert.deepEqual(runtime.sessionWaits, [
      {
        sessionId: createdSession.sessionId,
        condition: 'turn-complete',
        timeoutMs: 12_000,
      },
      {
        sessionId: createdSession.sessionId,
        condition: 'turn-complete',
        timeoutMs: 600_000,
      },
    ]);

    const prompted = await runControlCli([
      'session', 'prompt', createdSession.sessionId,
      '--file', '-', '--json', '--control-descriptor', runtime.descriptor.path,
    ], {
      repoRoot: REPO_ROOT,
      stdin: 'follow up\nwith context',
    });
    assert.equal(prompted.code, 0, prompted.stderr || prompted.stdout);
    assert.equal(JSON.parse(prompted.stdout).data.runtimeState, 'running');

    const keyed = await runCli([
      'session', 'send-keys', createdSession.sessionId,
      'escape', 'ctrl-c', 'enter', '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(keyed.code, 0, keyed.stderr || keyed.stdout);
    assert.equal(JSON.parse(keyed.stdout).data.runtimeState, 'input-required');

    const controlsBeforeInvalid = runtime.sessionControls.length;
    for (const args of [
      ['session', 'prompt', createdSession.sessionId],
      ['session', 'prompt', createdSession.sessionId, '--text', 'one', '--file', promptFile],
      ['session', 'send-keys', createdSession.sessionId],
      ['session', 'send-keys', createdSession.sessionId, 'enter', 'raw'],
    ]) {
      const invalid = await runCli([
        ...args, '--json', '--control-descriptor', runtime.descriptor.path,
      ]);
      assert.equal(invalid.code, 2, args.join(' '));
      assert.equal(JSON.parse(invalid.stdout).error.code, 'INVALID_USAGE');
    }
    const emptyPrompt = await runCli([
      'session', 'prompt', createdSession.sessionId, '--text', '   ', '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(emptyPrompt.code, 1);
    assert.equal(JSON.parse(emptyPrompt.stdout).error.code, 'INPUT_NOT_ACCEPTED');
    const unavailablePrompt = await runCli([
      'session', 'prompt', createdSession.sessionId,
      '--file', path.join(testRoot, 'missing-follow-up.txt'), '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(unavailablePrompt.code, 1);
    assert.equal(JSON.parse(unavailablePrompt.stdout).error.code, 'INPUT_NOT_ACCEPTED');
    assert.equal(runtime.sessionControls.length, controlsBeforeInvalid);

    const stopped = await runCli([
      'session', 'stop', createdSession.sessionId, '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(stopped.code, 0, stopped.stderr || stopped.stdout);
    assert.equal(JSON.parse(stopped.stdout).data.runtimeState, 'exited');
    assert.deepEqual(runtime.sessionControls, [
      { sessionId: createdSession.sessionId, kind: 'prompt', value: 'follow up\nwith context' },
      { sessionId: createdSession.sessionId, kind: 'keys', value: ['escape', 'ctrl-c', 'enter'] },
      { sessionId: createdSession.sessionId, kind: 'stop' },
    ]);

    const stoppedAgain = await runCli([
      'session', 'stop', createdSession.sessionId, '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(stoppedAgain.code, 1);
    assert.equal(JSON.parse(stoppedAgain.stdout).error.code, 'SESSION_RUNTIME_NOT_RUNNING');

    const timedOut = await runCli([
      'session', 'wait', createdSession.sessionId,
      '--for', 'input-required', '--timeout', '1', '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(timedOut.code, 124);
    assert.equal(JSON.parse(timedOut.stdout).error.code, 'WAIT_TIMEOUT');

    const oversized = await runCli([
      'session', 'launch', '--worktree', worktree.worktreeId,
      '--provider', 'codex', '--prompt-file', oversizedPromptFile, '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(oversized.code, 1);
    assert.equal(JSON.parse(oversized.stdout).error.code, 'INITIAL_PROMPT_TOO_LARGE');

    for (const args of [
      ['session', 'start', createdSession.sessionId],
      ['session', 'start', createdSession.sessionId, '--prompt', 'one', '--no-prompt'],
      ['session', 'launch', '--worktree', worktree.worktreeId, '--provider', 'codex'],
      [
        'session', 'launch', '--worktree', worktree.worktreeId, '--provider', 'codex',
        '--fast', '--no-fast', '--no-prompt',
      ],
      ['session', 'create', '--worktree', worktree.worktreeId],
      ['session', 'read', createdSession.sessionId, '--timeout', '1'],
      ['session', 'wait', createdSession.sessionId, '--for', 'done'],
      ['session', 'wait', createdSession.sessionId, '--for', 'running', '--timeout', '3601'],
    ]) {
      const invalid = await runCli([
        ...args, '--json', '--control-descriptor', runtime.descriptor.path,
      ]);
      assert.equal(invalid.code, 2, args.join(' '));
      assert.equal(JSON.parse(invalid.stdout).error.code, 'INVALID_USAGE');
    }

    for (const launchOnlyOption of [
      ['--prompt', 'must-not-be-read'],
      ['--prompt-file', path.join(testRoot, 'missing-prompt.txt')],
      ['--no-prompt'],
      ['--allow-preparation-failure'],
    ]) {
      const invalid = await runCli([
        'session', 'create', '--worktree', worktree.worktreeId,
        '--provider', 'codex', ...launchOnlyOption,
        '--json', '--control-descriptor', runtime.descriptor.path,
      ]);
      assert.equal(invalid.code, 2, launchOnlyOption[0]);
      assert.equal(JSON.parse(invalid.stdout).error.code, 'INVALID_USAGE');

      const invalidHelp = await runCli([
        'session', 'create', '--worktree', worktree.worktreeId,
        '--provider', 'codex', ...launchOnlyOption,
        '--help', '--json', '--control-descriptor', runtime.descriptor.path,
      ]);
      assert.equal(invalidHelp.code, 2, `${launchOnlyOption[0]} with --help`);
      assert.equal(JSON.parse(invalidHelp.stdout).error.code, 'INVALID_USAGE');
    }
  } finally {
    await runtime.close();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('Session commands reject malformed success DTOs before JSON or human rendering', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-control-session-dto-'));
  const session = {
    sessionId: 'session-valid-shape',
    worktreeId: 'wt_valid_shape',
    projectId: 'project-valid-shape',
    title: 'Valid shape',
    provider: 'codex',
    updatedAt: '2026-08-04T00:00:00.000Z',
  };
  const runtime = await startResponseRuntime(testRoot, 'malformed-session-dto', (pathname) => {
    let data: unknown;
    if (pathname.endsWith('/sessions/launch')) {
      data = { session, terminalId: '' };
    } else if (pathname.endsWith('/start')) {
      data = { session, terminalId: 7 };
    } else if (/\/worktrees\/[^/]+\/sessions$/.test(pathname)) {
      data = { sessions: [{ ...session, updatedAt: null }] };
    } else if (pathname.endsWith('/sessions')) {
      data = { ...session, provider: null };
    } else {
      data = { sessionId: 'missing-public-fields' };
    }
    return { ok: true, apiVersion: 1, data };
  });

  try {
    const commands = [
      ['session', 'list', '--worktree', 'wt_valid_shape'],
      ['session', 'show', 'session-valid-shape'],
      ['session', 'create', '--worktree', 'wt_valid_shape', '--provider', 'codex'],
      ['session', 'start', 'session-valid-shape', '--no-prompt'],
      ['session', 'read', 'session-valid-shape'],
      ['session', 'wait', 'session-valid-shape', '--for', 'turn-complete'],
      ['session', 'prompt', 'session-valid-shape', '--text', 'hello'],
      ['session', 'send-keys', 'session-valid-shape', 'enter'],
      ['session', 'stop', 'session-valid-shape'],
      [
        'session', 'launch', '--worktree', 'wt_valid_shape', '--provider', 'codex',
        '--no-prompt',
      ],
    ];
    for (const command of commands) {
      const result = await runCli([
        ...command, '--json', '--control-descriptor', runtime.descriptor.path,
      ]);
      assert.equal(result.code, 1, command.join(' '));
      assert.equal(JSON.parse(result.stdout).error.code, 'INSTANCE_UNAVAILABLE');
      assert.equal(result.stdout.trim().split('\n').length, 1);
      assert.equal(result.stderr, '');
    }

    const human = await runCli([
      'session', 'show', 'session-valid-shape',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    assert.equal(human.code, 1);
    assert.equal(human.stdout, '');
    assert.equal(
      human.stderr,
      'error: The selected Tessera runtime returned an invalid response.\n',
    );
  } finally {
    await runtime.close();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('Session launch failures never disclose internal provider diagnostics', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-control-session-errors-'));
  const sensitive = [
    '/home/private/worktree/secret',
    'guest stderr: permission denied',
    'credential=super-secret-token',
  ].join(' | ');
  const translated = toControlLaunchError(
    new ProviderLaunchError('LAUNCH_FAILED', sensitive),
    'session-sensitive',
  );
  const runtime = await startResponseRuntime(testRoot, 'sanitized-session-error', () => ({
    ok: false,
    apiVersion: 1,
    error: {
      code: translated.code,
      message: translated.message,
      details: translated.details,
    },
  }));

  try {
    const json = await runCli([
      'session', 'start', 'session-sensitive', '--no-prompt', '--json',
      '--control-descriptor', runtime.descriptor.path,
    ]);
    const human = await runCli([
      'session', 'start', 'session-sensitive', '--no-prompt',
      '--control-descriptor', runtime.descriptor.path,
    ]);

    assert.equal(json.code, 1);
    assert.equal(JSON.parse(json.stdout).error.code, 'INSTANCE_UNAVAILABLE');
    assert.equal(human.code, 1);
    assert.equal(
      human.stderr,
      'error: The Session runtime could not be started.\n',
    );
    for (const output of [json.stdout, json.stderr, human.stdout, human.stderr]) {
      assert.equal(output.includes(sensitive), false);
      assert.equal(output.includes('super-secret-token'), false);
      assert.equal(output.includes('/home/private'), false);
    }
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

async function startResponseRuntime(
  testRoot: string,
  label: string,
  responseFor: (pathname: string) => Record<string, unknown>,
): Promise<Pick<TestRuntime, 'descriptor' | 'close'>> {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const envelope = responseFor(pathname);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(envelope));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const descriptor = await publishRuntimeDescriptor({
    appVersion: PACKAGE_VERSION,
    origin,
    runtimeDirectory: path.join(testRoot, label),
  });
  return {
    descriptor,
    close: async () => {
      await descriptor.cleanup();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startRuntime(
  testRoot: string,
  label: string,
  project: { id: string; decodedPath: string; displayName: string; visible: boolean },
  worktrees: ControlWorktreeRecord[] = [],
): Promise<TestRuntime> {
  const sessionRecords: ControlSessionRecord[] = [];
  const sessionStarts: TestRuntime['sessionStarts'] = [];
  const sessionWaits: TestRuntime['sessionWaits'] = [];
  const sessionControls: TestRuntime['sessionControls'] = [];
  const liveSessions = new Set<string>();
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
  const serviceOptions = {
    appVersion: PACKAGE_VERSION,
    runtimeId: descriptor.descriptor.runtimeId,
    projects: {
      list: () => [project],
      get: (projectId) => projectId === project.id ? project : undefined,
    },
    worktrees: {
      list: (projectId) => worktrees.filter((worktree) => worktree.projectId === projectId),
      get: (worktreeId) => worktrees.find((worktree) => worktree.worktreeId === worktreeId),
    },
    worktreeCreator: {
      create: async (request: {
        project: typeof project;
        branch: string;
        startPoint: string;
        title?: string;
      }) => {
        const worktree: ControlWorktreeRecord = {
          worktreeId: `wt_created_${worktrees.length + 1}`,
          projectId: request.project.id,
          title: request.title ?? request.branch,
          branch: request.branch,
          filesystemPath: `/worktrees/${request.branch}`,
          preparationStatus: 'succeeded',
          preparationPhase: 'before',
          sessions: [],
        };
        worktrees.push(worktree);
        if (request.branch === 'feature/prep-timeout') {
          worktree.preparationStatus = 'running';
          throw new ControlWorktreeCreationError(
            'PREPARATION_TIMEOUT',
            'Worktree preparation did not finish before the timeout.',
            504,
            {},
            worktree,
            request.startPoint,
          );
        }
        return { worktree, startPoint: request.startPoint };
      },
    },
    sessions: {
      list: (worktreeId: string) => sessionRecords.filter(
        (session) => session.worktreeId === worktreeId,
      ),
      get: (sessionId: string) => sessionRecords.find(
        (session) => session.sessionId === sessionId,
      ),
    },
    sessionMutator: {
      create: async (request: {
        worktreeId: string;
        provider: string;
        title?: string;
        model?: string;
        reasoningEffort?: string;
        serviceTier?: string;
      }) => {
        const owner = worktrees.find((worktree) => worktree.worktreeId === request.worktreeId);
        if (!owner) throw new Error('missing test Worktree');
        const session: ControlSessionRecord = {
          sessionId: `session_created_${sessionRecords.length + 1}`,
          worktreeId: request.worktreeId,
          projectId: owner.projectId,
          title: request.title ?? 'New Session',
          provider: request.provider,
          providerState: JSON.stringify({ kind: 'terminal' }),
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          serviceTier: request.serviceTier,
          updatedAt: new Date().toISOString(),
        };
        sessionRecords.push(session);
        return session;
      },
      start: async (request: TestRuntime['sessionStarts'][number]) => {
        if (liveSessions.has(request.sessionId)) {
          throw new ControlOperationError(
            'SESSION_RUNTIME_ALREADY_RUNNING',
            'The Session already has a live PTY runtime.',
            409,
          );
        }
        sessionStarts.push(request);
        liveSessions.add(request.sessionId);
        return { terminalId: `session-${request.sessionId}` };
      },
      removeCreated: async (sessionId: string) => {
        const index = sessionRecords.findIndex((session) => session.sessionId === sessionId);
        if (index >= 0) sessionRecords.splice(index, 1);
      },
    },
    sessionObserver: {
      read: async () => ({
        screen: 'unique detached output',
        cols: 100,
        rows: 30,
        alternateScreen: false,
        outputSequence: 9,
        terminalId: 'terminal-observed',
        runtimeState: 'turn-complete' as const,
        stateAt: 4000,
        lifecyclePreview: 'provider response boundary',
      }),
      wait: async (sessionId: string, condition: string, timeoutMs: number) => {
        sessionWaits.push({ sessionId, condition, timeoutMs });
        if (condition === 'input-required') {
          throw new ControlOperationError(
            'WAIT_TIMEOUT',
            'The Session did not reach input-required before the timeout.',
            408,
          );
        }
        return {
          screen: 'unique detached output',
          cols: 100,
          rows: 30,
          alternateScreen: false,
          outputSequence: 9,
          terminalId: 'terminal-observed',
          runtimeState: 'turn-complete' as const,
          stateAt: 4000,
          lifecyclePreview: 'provider response boundary',
        };
      },
    },
    sessionController: {
      prompt: async (sessionId: string, text: string) => {
        if (!liveSessions.has(sessionId)) {
          throw new ControlOperationError(
            'SESSION_RUNTIME_NOT_RUNNING',
            'The Session does not have a live PTY runtime.',
            409,
          );
        }
        sessionControls.push({ sessionId, kind: 'prompt', value: text });
        return controlSnapshot('running');
      },
      sendKeys: async (sessionId: string, keys: string[]) => {
        if (!liveSessions.has(sessionId)) {
          throw new ControlOperationError(
            'SESSION_RUNTIME_NOT_RUNNING',
            'The Session does not have a live PTY runtime.',
            409,
          );
        }
        sessionControls.push({ sessionId, kind: 'keys', value: keys });
        return controlSnapshot('input-required');
      },
      stop: async (sessionId: string) => {
        if (!liveSessions.delete(sessionId)) {
          throw new ControlOperationError(
            'SESSION_RUNTIME_NOT_RUNNING',
            'The Session does not have a live PTY runtime.',
            409,
          );
        }
        sessionControls.push({ sessionId, kind: 'stop' });
        return controlSnapshot('exited');
      },
    },
  };
  const service = createControlService(serviceOptions as Parameters<typeof createControlService>[0]);
  requestHandler = createControlHttpHandler({ descriptor: descriptor.descriptor, service });

  return {
    descriptor,
    sessionStarts,
    sessionWaits,
    sessionControls,
    close: async () => {
      await descriptor.cleanup();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function controlSnapshot(runtimeState: 'running' | 'input-required' | 'exited') {
  return {
    screen: 'unique detached output',
    cols: runtimeState === 'exited' ? null : 100,
    rows: runtimeState === 'exited' ? null : 30,
    alternateScreen: false,
    outputSequence: 9,
    terminalId: 'terminal-observed',
    runtimeState,
    stateAt: 4000,
    lifecyclePreview: 'provider response boundary',
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

function runCli(
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runControlCli(args, { repoRoot: REPO_ROOT, envOverrides });
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createControlHttpHandler } from '../src/lib/control/http-handler';
import { publishRuntimeDescriptor } from '../src/lib/control/runtime-descriptor';
import {
  createControlService,
  type ControlSessionOpenOutcome,
} from '../src/lib/control/service';
import {
  requestSessionOpen,
  resolveSessionOpenResponse,
} from '../src/lib/ws/session-open-requests';
import { runControlCli } from './helpers/control-cli-runner';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-control-search-'));
process.env.TESSERA_DATA_DIR = path.join(testRoot, 'data');
process.env.TESSERA_PRODUCTION_DB = '1';
const PACKAGE_VERSION = JSON.parse(fs.readFileSync('package.json', 'utf8')).version as string;

test.after(() => fs.rmSync(testRoot, { recursive: true, force: true }));

test('the CLI searches, opens and renames any non-deleted Session', async (t) => {
  const [database, projects, tasks, sessions, bindings, catalog, renamer, webSocket] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/db/tasks'),
    import('@/lib/db/sessions'),
    import('@/lib/db/terminal-provider-sessions'),
    import('@/lib/control/database-session-catalog'),
    import('@/lib/control/session-renamer'),
    import('@/lib/ws/server'),
  ]);
  await database.initDatabase();
  const projectId = path.join(testRoot, 'project');
  const otherProjectId = path.join(testRoot, 'other');
  projects.registerProject(projectId, projectId, 'Tessera Dev');
  projects.registerProject(otherProjectId, otherProjectId, 'Science Channel');
  const taskId = 'search-task';
  tasks.createTask({ id: taskId, projectId, title: 'ConPTY 수정', worktreeBranch: 'fix/conpty' });
  sessions.createSession('s-terminal', projectId, 'Windows 터미널 렌더러 디버깅', 'claude-code', {
    taskId, providerState: JSON.stringify({ kind: 'terminal' }),
  });
  bindings.bindTerminalProviderSession({
    providerId: 'claude-code', providerSessionId: 'claude-uuid-1', tesseraSessionId: 's-terminal',
    transcriptPath: '/home/u/.claude/projects/x/claude-uuid-1.jsonl',
  });
  sessions.createSession('s-chat', otherProjectId, 'Shorts 대본 정리', 'codex', {
    providerState: JSON.stringify({ threadId: 'codex-thread-9' }),
  });
  sessions.updateSession('s-chat', { archived: 1 });
  sessions.createSession('s-deleted', projectId, 'Windows 삭제됨', 'claude-code');
  sessions.softDeleteSession('s-deleted');

  const opens: string[] = [];
  const mutations: Array<Record<string, unknown>> = [];
  t.mock.method(webSocket.wsServer, 'sendToUser', (userId: string, message: Record<string, unknown>) => {
    mutations.push({ userId, ...message });
    return 1;
  });
  let outcome: ControlSessionOpenOutcome = { deliveredClients: 2, openedClients: 1 };
  let handler: ReturnType<typeof createControlHttpHandler> | undefined;
  const server = http.createServer((request, response) => {
    void handler!(request, response).then((handled) => { if (!handled) response.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const runtime = await publishRuntimeDescriptor({
    appVersion: PACKAGE_VERSION,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    runtimeDirectory: path.join(testRoot, 'runtime'),
  });
  handler = createControlHttpHandler({
    descriptor: runtime.descriptor,
    service: createControlService({
      appVersion: PACKAGE_VERSION,
      runtimeId: runtime.descriptor.runtimeId,
      projects: {
        list: () => [],
        get: (id) => (id === projectId ? { id, decodedPath: id, displayName: 'Tessera Dev', visible: true } : undefined),
      },
      worktrees: { list: () => [], get: () => undefined },
      sessionCatalog: catalog.createDatabaseControlSessionCatalog(),
      sessionOpener: { open: async (sessionId) => { opens.push(sessionId); return outcome; } },
      sessionRenamer: renamer.createDatabaseControlSessionRenamer({ userId: 'u' }),
    }),
  });
  const cli = async (...args: string[]) => {
    const result = await runControlCli([...args, '--json', '--control-descriptor', runtime.path]);
    return { code: result.code, body: JSON.parse(result.stdout) };
  };
  const ids = (body: { data: { sessions: Array<{ sessionId: string }> } }) => (
    body.data.sessions.map((session) => session.sessionId)
  );

  try {
    const all = await cli('session', 'search');
    assert.equal(all.code, 0);
    assert.deepEqual(ids(all.body).sort(), ['s-chat', 's-terminal']);

    const terminal = await cli('session', 'search', 'windows', '렌더러');
    assert.deepEqual(terminal.body.data, {
      sessions: [{
        sessionId: 's-terminal', title: 'Windows 터미널 렌더러 디버깅', provider: 'claude-code',
        createdAt: terminal.body.data.sessions[0].createdAt,
        updatedAt: terminal.body.data.sessions[0].updatedAt,
        projectId, projectName: 'Tessera Dev',
        worktreeId: terminal.body.data.sessions[0].worktreeId,
        worktreeTitle: 'ConPTY 수정', branch: 'fix/conpty',
        providerSessionId: 'claude-uuid-1',
        transcriptPath: '/home/u/.claude/projects/x/claude-uuid-1.jsonl',
        kind: 'terminal', archived: false,
      }],
      total: 1,
      truncated: false,
    });
    assert.ok(terminal.body.data.sessions[0].worktreeId);

    assert.deepEqual(ids((await cli('session', 'search', 'CODEX-THREAD-9')).body), ['s-chat']);
    assert.equal((await cli('session', 'search', 'science', 'shorts')).body.data.sessions[0].archived, true);
    assert.deepEqual(ids((await cli('session', 'search', '--active-only')).body), ['s-terminal']);
    assert.deepEqual(ids((await cli('session', 'search', '--project', projectId)).body), ['s-terminal']);
    assert.deepEqual(ids((await cli('session', 'search', '삭제됨')).body), []);
    const none = await runControlCli(['session', 'search', '삭제됨', '--control-descriptor', runtime.path]);
    assert.equal(none.stdout, 'No Sessions matched.\n');
    const limited = await cli('session', 'search', '--limit', '1');
    assert.equal(limited.body.data.sessions.length, 1);
    assert.equal(limited.body.data.truncated, true);
    for (const args of [['--limit', '0'], ['--limit', '101'], ['--current', '--project', 'x'], ['--bogus']]) {
      assert.equal((await cli('session', 'search', ...args)).code, 2);
    }

    const opened = await cli('session', 'open', 's-chat');
    assert.deepEqual(opened, {
      code: 0,
      body: { ok: true, apiVersion: 1, data: { sessionId: 's-chat', opened: true, openedClients: 1 } },
    });
    outcome = { deliveredClients: 1, openedClients: 0 };
    const hidden = await cli('session', 'open', 's-terminal');
    assert.equal(hidden.code, 1);
    assert.equal(hidden.body.error.code, 'UI_UNAVAILABLE');
    const missing = await cli('session', 'open', 's-deleted');
    assert.equal(missing.body.error.code, 'SESSION_NOT_FOUND');
    assert.deepEqual(opens, ['s-chat', 's-terminal']);

    const renamed = await cli('session', 'rename', 's-terminal', '  ConPTY 렌더러 원인  ');
    assert.deepEqual(renamed, {
      code: 0,
      body: { ok: true, apiVersion: 1, data: { sessionId: 's-terminal', title: 'ConPTY 렌더러 원인' } },
    });
    assert.equal(sessions.getSession('s-terminal')?.title, 'ConPTY 렌더러 원인');
    assert.equal(sessions.getSession('s-terminal')?.has_custom_title, 1);
    assert.deepEqual(mutations, [{
      userId: 'u', type: 'session_mutated', kind: 'updated',
      projectId, sessionId: 's-terminal', taskId,
    }]);
    assert.deepEqual(ids((await cli('session', 'search', '원인')).body), ['s-terminal']);
    const human = await runControlCli([
      'session', 'rename', 's-terminal', '--control-descriptor', runtime.path, '--', '-v2 정리',
    ]);
    assert.equal(human.stdout, 'Renamed Session s-terminal to -v2 정리\n');
    for (const args of [['s-terminal'], ['s-terminal', 'a', 'b'], ['s-terminal', '-v2'], ['s-terminal', '  ']]) {
      assert.equal((await cli('session', 'rename', ...args)).code, 2);
    }
    for (const title of ['x'.repeat(101), 'two\nlines']) {
      const invalid = await cli('session', 'rename', 's-terminal', title);
      assert.equal(invalid.body.error.code, 'INVALID_USAGE');
    }
    const gone = await cli('session', 'rename', 's-deleted', 'Revived');
    assert.equal(gone.body.error.code, 'SESSION_NOT_FOUND');
    assert.equal(sessions.getSession('s-terminal')?.title, '-v2 정리');
  } finally {
    await runtime.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('an open request resolves on the first window that shows the Session', async () => {
  const sent: Array<{ userId: string; openId: string }> = [];
  const send = (count: number) => (userId: string, message: { type: string; openId?: string }) => {
    if (message.type === 'session_open_request' && message.openId) sent.push({ userId, openId: message.openId });
    return count;
  };

  assert.deepEqual(
    await requestSessionOpen({ userId: 'u', sessionId: 's', sendToUser: send(0) }),
    { deliveredClients: 0, openedClients: 0 },
  );

  const shown = requestSessionOpen({ userId: 'u', sessionId: 's', sendToUser: send(3) });
  const { openId } = sent.at(-1)!;
  resolveSessionOpenResponse('someone-else', openId, true);
  resolveSessionOpenResponse('u', openId, false);
  resolveSessionOpenResponse('u', openId, true);
  assert.deepEqual(await shown, { deliveredClients: 3, openedClients: 1 });

  const declined = requestSessionOpen({ userId: 'u', sessionId: 's', sendToUser: send(2) });
  resolveSessionOpenResponse('u', sent.at(-1)!.openId, false);
  resolveSessionOpenResponse('u', sent.at(-1)!.openId, false);
  assert.deepEqual(await declined, { deliveredClients: 2, openedClients: 0 });

  const silent = await requestSessionOpen({
    userId: 'u', sessionId: 's', sendToUser: send(1), timeoutMs: 20,
  });
  assert.deepEqual(silent, { deliveredClients: 1, openedClients: 0 });
});

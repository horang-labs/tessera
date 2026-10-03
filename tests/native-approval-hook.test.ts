import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCodexHookSettings } from '@/lib/terminal/codex-hook-settings';
import { buildClaudeHookSettings } from '@/lib/terminal/claude-hook-settings';

test('only PermissionRequest installs the blocking once-only native transport', () => {
  const hooks = buildCodexHookSettings().hooks;
  assert.notEqual(hooks.PermissionRequest[0].hooks[0].command, hooks.Stop[0].hooks[0].command);
  assert.equal(hooks.PermissionRequest[0].hooks[0].timeout, 120);
  const claude = buildClaudeHookSettings() as { hooks: typeof hooks };
  assert.notEqual(claude.hooks.PermissionRequest[0].hooks[0].command, claude.hooks.Stop[0].hooks[0].command);
});

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildNativeApprovalHookCommand } from '@/lib/terminal/native-approval-hook';

async function runHook(managed: boolean, unsafeOutput = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-hook-'));
  fs.writeFileSync(path.join(root, 'codex'), '#!/bin/sh\necho codex-cli 0.159.2\n', { mode: 0o700 });
  const events: string[] = []; let requestId = '';
  const server = http.createServer((req, res) => {
    let text = ''; req.on('data', data => text += data); req.on('end', () => {
      const body = JSON.parse(text); events.push(body.hook_event_name);
      assert.equal(req.headers['x-tessera-pane-token'], 'owned-token');
      if (body.hook_event_name === 'TesseraApprovalProbe') {
        if (managed) res.end(JSON.stringify({ enabled: true })); else res.writeHead(204).end();
      } else if (body.hook_event_name === 'PermissionRequest' && managed) {
        requestId = body.tessera_native_approval.invocationId;
        assert.equal(body.tessera_native_approval.generation, 2);
        res.end(JSON.stringify({ requestId, requestHash: 'c'.repeat(64), optionId: 'allow-once' }));
      } else if (body.hook_event_name === 'TesseraApprovalCommit') {
        assert.equal(body.requestId, requestId);
        res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow', ...(unsafeOutput ? { updatedPermissions: [] } : {}) } } }));
      } else res.writeHead(204).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn('sh', ['-c', buildNativeApprovalHookCommand('posix', 'codex')], { env: { ...process.env,
        PATH: `${root}:${process.env.PATH}`, TESSERA_TERMINAL_GENERATION: '2',
        TESSERA_HOOK_PORT: String((server.address() as AddressInfo).port), TESSERA_SESSION_ID: 'worker', TESSERA_PANE_TOKEN: 'owned-token' },
        stdio: ['pipe', 'pipe', 'ignore'] });
      let stdout = ''; child.stdout.on('data', data => stdout += data); child.on('error', reject);
      child.on('close', code => resolve({ code, stdout }));
      child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'native', turn_id: 'turn',
        tool_name: 'exec_command', tool_input: { command: 'cat marker.txt' }, cwd: root }));
    });
    assert.equal(result.code, 0); return { ...result, events };
  } finally { server.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

test('real hook subprocess returns one-time stdout only after exact offer/commit; ack follows pipe write', async () => {
  const result = await runHook(true);
  assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.deepEqual(result.events, ['TesseraApprovalProbe', 'PermissionRequest', 'TesseraApprovalCommit', 'TesseraApprovalAck']);
});
test('unmanaged/Heartbeat returns native manual flow, and policy-changing outputs are rejected', async () => {
  const manual = await runHook(false); assert.equal(manual.stdout, '');
  assert.deepEqual(manual.events, ['TesseraApprovalProbe', 'PermissionRequest']);
  const unsafe = await runHook(true, true); assert.equal(unsafe.stdout, '');
  assert.equal(unsafe.events.includes('TesseraApprovalAck'), false);
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { buildHookCommand } from '@/lib/terminal/hook-command';

test('posix hook command posts the stdin payload with the pane token', async () => {
  const received: Array<{ url: string; token: string | undefined; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({
        url: req.url ?? '',
        token: req.headers['x-tessera-pane-token'] as string | undefined,
        body,
      });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: 'abc' });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      // claude/codex가 훅을 실행하는 방식과 동일: sh -c '<command>', payload는 stdin.
      const child = spawn('sh', ['-c', buildHookCommand('posix')], {
        env: {
          ...process.env,
          TESSERA_HOOK_PORT: String(port),
          TESSERA_SESSION_ID: 'session-hook-test',
          TESSERA_PANE_TOKEN: 'pane-token-hook-test',
          // 이 테스트 자체가 WSL에서 돌 수 있다 — 1차 curl이 성공하므로
          // curl.exe 폴백은 트리거되지 않아야 한다.
        },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.on('error', reject);
      child.on('close', resolve);
      child.stdin.end(payload);
    });

    // 순수 lifecycle observer 계약: 항상 성공 종료.
    assert.equal(exitCode, 0);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/__tessera/hook?session=session-hook-test');
    assert.equal(received[0].token, 'pane-token-hook-test');
    assert.equal(received[0].body, payload);
  } finally {
    server.close();
  }
});

test('posix hook command exits 0 even when the server is unreachable', async () => {
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn('sh', ['-c', buildHookCommand('posix')], {
      env: {
        ...process.env,
        // 예약 포트에 아무도 없음 — 1차 curl 실패, (WSL이면) curl.exe 폴백도 실패.
        TESSERA_HOOK_PORT: '9',
        TESSERA_SESSION_ID: 's',
        TESSERA_PANE_TOKEN: 't',
        // 폴백 경로가 실 Windows 호스트로 나가지 않게 WSL 감지를 우회한다.
        WSL_DISTRO_NAME: '',
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', reject);
    child.on('close', resolve);
    child.stdin.end('{}');
  });
  assert.equal(exitCode, 0);
});

test('posix hook command retries through curl.exe on WSL runtimes', () => {
  const command = buildHookCommand('posix');
  // stdin은 한 번만 읽힌다 — 재시도를 위해 변수로 캡처해야 한다.
  assert.match(command, /payload=\$\(cat\)/);
  // WSL 감지: env 우선, /proc/version 폴백.
  assert.match(command, /WSL_DISTRO_NAME/);
  assert.match(command, /\/proc\/version/);
  // interop PATH의 curl.exe → 절대경로 폴백 순.
  assert.match(command, /tessera_hook_post curl\.exe 3 5 \|\| tessera_hook_post \/mnt\/c\/Windows\/System32\/curl\.exe 3 5/);
  assert.match(command, /\|\| true$/);
});

test('windows-cmd hook command uses the fully-qualified curl.exe with %VAR% expansion', () => {
  const command = buildHookCommand('windows-cmd');
  // 경로를 풀로 적어 repo-local curl.exe 하이재킹을 차단(orca와 동일).
  assert.match(command, /^"%SystemRoot%\\System32\\curl\.exe"/);
  assert.match(command, /%TESSERA_HOOK_PORT%/);
  assert.match(command, /%TESSERA_SESSION_ID%/);
  assert.match(command, /%TESSERA_PANE_TOKEN%/);
  // cmd 문법: >nul 리다이렉트 + 무조건 성공 종료.
  assert.match(command, />nul 2>&1 & exit \/b 0$/);
  // POSIX 전용 문법이 섞이면 cmd에서 깨진다.
  assert.doesNotMatch(command, /\|\| true|\/dev\/null|\$TESSERA/);
});

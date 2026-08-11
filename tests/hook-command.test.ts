import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
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

test('posix hook command exits 0 when the local curl fails', async () => {
  // WSL 감지는 env를 비워도 /proc/version 폴백으로 참이 될 수 있다(이 테스트가
  // WSL 개발 머신에서 돌 때). env 우회 대신 PATH 스텁으로 격리한다: curl은 실패,
  // curl.exe는 성공 — 성공시켜야 스텁 불가능한 /mnt/c 절대경로 폴백(실 interop
  // curl.exe)까지 내려가지 않는다. 비-WSL 머신에서는 curl 실패 후 즉시 || true.
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-curl-stub-'));
  fs.writeFileSync(path.join(stubDir, 'curl'), '#!/bin/sh\nexit 7\n');
  fs.writeFileSync(path.join(stubDir, 'curl.exe'), '#!/bin/sh\ncat >/dev/null\nexit 0\n');
  for (const name of ['curl', 'curl.exe']) {
    fs.chmodSync(path.join(stubDir, name), 0o755);
  }
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('sh', ['-c', buildHookCommand('posix')], {
        env: {
          ...process.env,
          PATH: `${stubDir}:${process.env.PATH ?? ''}`,
          TESSERA_HOOK_PORT: '9',
          TESSERA_SESSION_ID: 's',
          TESSERA_PANE_TOKEN: 't',
        },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.on('error', reject);
      child.on('close', resolve);
      child.stdin.end('{}');
    });
    assert.equal(exitCode, 0);
  } finally {
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});

test('posix lifecycle hook drains stdin and performs no work outside a Managed Session', async (t) => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-hook-noop-'));
  t.after(() => fs.rmSync(stubDir, { recursive: true, force: true }));
  const marker = path.join(stubDir, 'curl-was-called');
  fs.writeFileSync(
    path.join(stubDir, 'curl'),
    `#!/bin/sh\n: > '${marker}'\ncat >/dev/null\nexit 0\n`,
    { mode: 0o755 },
  );

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn('sh', ['-c', buildHookCommand('posix')], {
      env: {
        PATH: `${stubDir}:${process.env.PATH ?? ''}`,
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', reject);
    child.on('close', resolve);
    child.stdin.end('{"hook_event_name":"Stop"}\n');
  });

  assert.equal(exitCode, 0);
  assert.equal(fs.existsSync(marker), false);
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
  // --fail이 빠지면 남의 서버의 401/403이 exit 0으로 취급돼 폴백 전체가 무력화된다.
  assert.match(command, /-sS --fail /);
  assert.match(command, /\|\| true$/);
});

/**
 * 회귀: 게스트 포트를 다른 Tessera 인스턴스가 선점한 상황(npm CLI와 Electron의 기본 포트가
 * 둘 다 32123). 그 서버는 pane token을 모르니 401/403을 주는데, --fail이 없으면 curl이
 * exit 0을 반환해 폴백이 죽고 훅이 통째로 유실된다 — 인디케이터가 멈추고 history가 안 쌓여
 * resume까지 깨진다. 연결 거부(exit 7)가 아니라 "연결은 됐지만 남의 서버"를 재현한다.
 */
test('posix hook command falls through to curl.exe when a foreign server rejects the token', async () => {
  let rejected = 0;
  const foreign = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { rejected += 1; res.writeHead(403).end(); });
  });
  await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  const port = (foreign.address() as AddressInfo).port;

  // curl은 스텁하지 않는다 — 실제 curl이 403을 어떻게 다루는지가 이 테스트의 핵심.
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-curl-foreign-'));
  const marker = path.join(stubDir, 'fallback-used');
  fs.writeFileSync(path.join(stubDir, 'curl.exe'), `#!/bin/sh\ncat >/dev/null\n: > '${marker}'\nexit 0\n`);
  fs.chmodSync(path.join(stubDir, 'curl.exe'), 0o755);

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('sh', ['-c', buildHookCommand('posix')], {
        env: {
          ...process.env,
          PATH: `${stubDir}:${process.env.PATH ?? ''}`,
          // 비-WSL CI에서도 폴백 분기를 타도록 런타임 감지를 강제한다.
          WSL_DISTRO_NAME: 'Ubuntu-test',
          TESSERA_HOOK_PORT: String(port),
          TESSERA_SESSION_ID: 's',
          TESSERA_PANE_TOKEN: 'wrong-token',
        },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.on('error', reject);
      child.on('close', resolve);
      child.stdin.end('{}');
    });

    assert.equal(exitCode, 0);
    assert.equal(rejected, 1, '남의 서버가 훅을 한 번 거절해야 한다');
    assert.ok(fs.existsSync(marker), '403을 받으면 curl.exe 폴백으로 넘어가야 한다');
  } finally {
    foreign.close();
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});

/** --fail이 정상 경로를 건드리지 않는지: 204를 받으면 폴백을 타면 안 된다(훅 중복 전송 방지). */
test('posix hook command does not fall through when the owning server accepts', async () => {
  let accepted = 0;
  const owner = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { accepted += 1; res.writeHead(204).end(); });
  });
  await new Promise<void>((resolve) => owner.listen(0, '127.0.0.1', resolve));
  const port = (owner.address() as AddressInfo).port;

  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-curl-owner-'));
  const marker = path.join(stubDir, 'fallback-used');
  fs.writeFileSync(path.join(stubDir, 'curl.exe'), `#!/bin/sh\ncat >/dev/null\n: > '${marker}'\nexit 0\n`);
  fs.chmodSync(path.join(stubDir, 'curl.exe'), 0o755);

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('sh', ['-c', buildHookCommand('posix')], {
        env: {
          ...process.env,
          PATH: `${stubDir}:${process.env.PATH ?? ''}`,
          WSL_DISTRO_NAME: 'Ubuntu-test',
          TESSERA_HOOK_PORT: String(port),
          TESSERA_SESSION_ID: 's',
          TESSERA_PANE_TOKEN: 't',
        },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.on('error', reject);
      child.on('close', resolve);
      child.stdin.end('{}');
    });

    assert.equal(exitCode, 0);
    assert.equal(accepted, 1);
    assert.equal(fs.existsSync(marker), false, '204를 받으면 폴백을 타면 안 된다');
  } finally {
    owner.close();
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});

test('windows-cmd hook command uses the fully-qualified curl.exe with %VAR% expansion', () => {
  const command = buildHookCommand('windows-cmd');
  // 경로를 풀로 적어 repo-local curl.exe 하이재킹을 차단(orca와 동일).
  assert.match(command, /"%SystemRoot%\\System32\\curl\.exe"/);
  assert.match(command, /^if not defined TESSERA_HOOK_PORT \(more >nul & exit \/b 0\)/);
  assert.match(command, /%TESSERA_HOOK_PORT%/);
  assert.match(command, /%TESSERA_SESSION_ID%/);
  assert.match(command, /%TESSERA_PANE_TOKEN%/);
  // cmd 문법: >nul 리다이렉트 + 무조건 성공 종료.
  assert.match(command, />nul 2>&1 & exit \/b 0$/);
  // POSIX 전용 문법이 섞이면 cmd에서 깨진다.
  assert.doesNotMatch(command, /\|\| true|\/dev\/null|\$TESSERA/);
});

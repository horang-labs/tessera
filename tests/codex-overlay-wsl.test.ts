import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildWslCodexOverlayCleanupScript,
  buildWslCodexOverlayCreateScript,
  buildWslCodexOverlayFinalizeScript,
  readWslOverlayReport,
} from '@/lib/terminal/codex-overlay-wsl';

/**
 * 게스트 스크립트는 순수 POSIX sh다 — 서버가 win32에서 wsl.exe로 흘려보내는 것과
 * 동일한 내용을 이 리눅스 테스트 환경의 sh로 직접 실행해 게스트측 동작을 검증한다.
 */
function runScript(script: string, home: string): string {
  return execFileSync('sh', ['-s'], {
    input: script,
    env: { ...process.env, HOME: home, CODEX_HOME: '' },
    encoding: 'utf8',
  });
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

test('WSL overlay create script mirrors the codex home with guest-native symlinks', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-wsl-overlay-'));
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"token":"live"}');
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.4"\n\n[hooks.state."stale"]\nenabled = true\n');
  fs.writeFileSync(path.join(codexHome, 'hooks.json'), '{"user":"hooks"}');
  fs.writeFileSync(path.join(codexHome, '.hidden-file'), 'hidden');

  try {
    const hooksJson = '{"hooks":{}}\n';
    const stdout = runScript(
      buildWslCodexOverlayCreateScript('terminal-wsl-test', b64(hooksJson)),
      home,
    );

    const overlay = readWslOverlayReport(stdout, 'TESSERA_OVERLAY');
    assert.equal(overlay, path.join(home, '.tessera/codex-overlay/terminal-wsl-test'));
    assert.equal(readWslOverlayReport(stdout, 'TESSERA_SRC'), codexHome);
    // readlink -f 결과 — trust 키에 들어갈 canonical 경로.
    const hooksReal = readWslOverlayReport(stdout, 'TESSERA_HOOKS_REAL');
    assert.equal(hooksReal, fs.realpathSync(path.join(overlay!, 'hooks.json')));

    // auth.json/sessions는 라이브 심링크(계약: 토큰 갱신·resume 관통).
    assert.equal(fs.readlinkSync(path.join(overlay!, 'auth.json')), path.join(codexHome, 'auth.json'));
    assert.equal(fs.readlinkSync(path.join(overlay!, 'sessions')), path.join(codexHome, 'sessions'));
    assert.equal(fs.readlinkSync(path.join(overlay!, '.hidden-file')), path.join(codexHome, '.hidden-file'));
    // hooks.json은 우리 파일(심링크 아님), config.toml은 아직 없음(2차에서 기록).
    assert.equal(fs.lstatSync(path.join(overlay!, 'hooks.json')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(overlay!, 'hooks.json'), 'utf8'), hooksJson);
    assert.equal(fs.existsSync(path.join(overlay!, 'config.toml')), false);

    // 실 config.toml은 base64로 보고된다 — 호스트가 hooks.state를 스트립하고
    // trust를 덧붙여 2차로 되쓴다.
    const configB64 = readWslOverlayReport(stdout, 'TESSERA_CONFIG_B64');
    assert.ok(configB64);
    assert.match(Buffer.from(configB64!, 'base64').toString('utf8'), /model = "gpt-5\.4"/);

    // 2차: 최종 config.toml + 마커 기록.
    const finalConfig = 'model = "gpt-5.4"\n\n[hooks.state."x"]\nenabled = true\n';
    const marker = '{"kind":"tessera-codex-overlay","accountHome":"' + codexHome + '"}\n';
    runScript(
      buildWslCodexOverlayFinalizeScript('terminal-wsl-test', b64(finalConfig), b64(marker)),
      home,
    );
    assert.equal(fs.readFileSync(path.join(overlay!, 'config.toml'), 'utf8'), finalConfig);
    assert.equal(fs.readFileSync(path.join(overlay!, '.tessera-overlay.json'), 'utf8'), marker);

    // 재실행(stale 재생성)이 이전 잔여를 지우고 실 홈은 건드리지 않는다.
    runScript(buildWslCodexOverlayCreateScript('terminal-wsl-test', b64(hooksJson)), home);
    assert.equal(fs.existsSync(path.join(overlay!, 'config.toml')), false);
    assert.equal(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'), '{"token":"live"}');

    // 정리 스크립트는 오버레이만 제거(심링크 타깃 무손상).
    runScript(buildWslCodexOverlayCleanupScript('terminal-wsl-test'), home);
    assert.equal(fs.existsSync(overlay!), false);
    assert.equal(fs.existsSync(path.join(codexHome, 'auth.json')), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('WSL overlay create script tolerates a missing codex home', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-wsl-overlay-empty-'));
  try {
    const stdout = runScript(
      buildWslCodexOverlayCreateScript('terminal-wsl-empty', b64('{}')),
      home,
    );
    const overlay = readWslOverlayReport(stdout, 'TESSERA_OVERLAY');
    assert.ok(overlay);
    assert.equal(fs.readFileSync(path.join(overlay!, 'hooks.json'), 'utf8'), '{}');
    // config가 없으면 보고 라인도 없다.
    assert.equal(readWslOverlayReport(stdout, 'TESSERA_CONFIG_B64'), undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('WSL overlay scripts reject unsafe terminal ids and payloads', () => {
  assert.throws(() => buildWslCodexOverlayCreateScript('../escape', b64('{}')));
  assert.throws(() => buildWslCodexOverlayCreateScript('a; rm -rf /', b64('{}')));
  assert.throws(() => buildWslCodexOverlayCreateScript('ok', "'; rm -rf /"));
  assert.throws(() => buildWslCodexOverlayFinalizeScript('ok', 'not base64!', b64('{}')));
  assert.throws(() => buildWslCodexOverlayCleanupScript('bad id'));
});

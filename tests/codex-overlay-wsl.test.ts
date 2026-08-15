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
  buildWslCodexOverlayResumeRepairScript,
  buildWslCodexTrustBaselineWriteScript,
  buildWslCodexTrustPromotionScript,
  buildWslCodexTrustReportScript,
  cleanupCodexOverlayInWsl,
  createCodexOverlayInWsl,
  readWslOverlayReport,
} from '@/lib/terminal/codex-overlay-wsl';
import {
  mergeCodexOverlayTrust,
  serializeCodexTrustBaseline,
} from '@/lib/terminal/codex-trust-state';

const WSL_LIFECYCLE_TEST_TIMEOUT_MS = 15_000;

/**
 * 게스트 스크립트는 순수 POSIX sh다 — 서버가 win32에서 wsl.exe로 흘려보내는 것과
 * 동일한 내용을 이 리눅스 테스트 환경의 sh로 직접 실행해 게스트측 동작을 검증한다.
 */
function runScript(
  script: string,
  home: string,
  extraEnv: NodeJS.ProcessEnv = {},
): string {
  return execFileSync('sh', ['-s'], {
    input: script,
    env: { ...process.env, HOME: home, CODEX_HOME: '', ...extraEnv },
    encoding: 'utf8',
  });
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function installFakeWsl(
  prefix: string,
  options: {
    watcherReadyDelaySeconds?: string;
    concurrentConfigBeforeFirstPromotion?: string;
    exitFirstWatcherAfterReady?: boolean;
    hangFirstWatcherBeforeReady?: boolean;
  } = {},
): {
  accountConfigPath: string;
  restore: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const guestHome = path.join(root, 'guest-home');
  const fakeBin = path.join(root, 'bin');
  const accountConfigPath = path.join(guestHome, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(accountConfigPath), { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(accountConfigPath, 'model = "gpt-5.4"\n');
  fs.writeFileSync(
    path.join(fakeBin, 'wsl.exe'),
    [
      '#!/bin/sh',
      'HOME="$TESSERA_TEST_WSL_HOME"',
      'export HOME',
      'if [ "$1" = "--exec" ]; then',
      '  shift',
      '  if [ -n "${TESSERA_TEST_WSL_WATCH_DELAY:-}" ] || [ -n "${TESSERA_TEST_WSL_CONCURRENT_CONFIG_B64:-}" ] || [ -n "${TESSERA_TEST_WSL_EXIT_FIRST_WATCHER:-}" ] || [ -n "${TESSERA_TEST_WSL_HANG_FIRST_WATCHER:-}" ]; then',
      '    script="$TESSERA_TEST_WSL_HOME/.tessera-test-wsl-script-$$"',
      '    cat > "$script"',
      '    if [ -n "${TESSERA_TEST_WSL_WATCH_DELAY:-}" ] && grep -q TESSERA_TRUST_WATCH_READY "$script" && [ ! -f "$TESSERA_TEST_WSL_HOME/.tessera-test-wsl-watch-delayed" ]; then',
      '      : > "$TESSERA_TEST_WSL_HOME/.tessera-test-wsl-watch-delayed"',
      '      sleep "$TESSERA_TEST_WSL_WATCH_DELAY"',
      '    fi',
      '    if [ -n "${TESSERA_TEST_WSL_EXIT_FIRST_WATCHER:-}" ] && grep -q TESSERA_TRUST_WATCH_READY "$script" && [ ! -f "$TESSERA_TEST_WSL_HOME/.tessera-test-wsl-watcher-exited" ]; then',
      '      : > "$TESSERA_TEST_WSL_HOME/.tessera-test-wsl-watcher-exited"',
      '      awk \'{ if ($0 ~ /^while \\[ -f "\\$config" \\]; do$/) print "exit 0"; print }\' "$script" > "$script.once"',
      '      mv "$script.once" "$script"',
      '    fi',
      '    if [ -n "${TESSERA_TEST_WSL_HANG_FIRST_WATCHER:-}" ] && grep -q TESSERA_TRUST_WATCH_READY "$script" && [ ! -f "$TESSERA_TEST_WSL_HOME/.tessera-test-wsl-watcher-hung" ]; then',
      '      : > "$TESSERA_TEST_WSL_HOME/.tessera-test-wsl-watcher-hung"',
      '      awk \'{ if ($0 ~ /^last=/) print "while :; do :; done"; print }\' "$script" > "$script.once"',
      '      mv "$script.once" "$script"',
      '    fi',
      '    if [ -n "${TESSERA_TEST_WSL_CONCURRENT_CONFIG_B64:-}" ] && grep -q "config.toml.tessera" "$script" && [ ! -f "$TESSERA_TEST_WSL_HOME/.tessera-test-wsl-injected" ]; then',
      '      printf "%s" "$TESSERA_TEST_WSL_CONCURRENT_CONFIG_B64" | base64 -d > "$TESSERA_TEST_WSL_HOME/.codex/config.toml"',
      '      : > "$TESSERA_TEST_WSL_HOME/.tessera-test-wsl-injected"',
      '    fi',
      '    exec sh "$script"',
      '  fi',
      '  exec "$@"',
      'fi',
      'exit 2',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );

  const previousPath = process.env.PATH;
  const previousGuestHome = process.env.TESSERA_TEST_WSL_HOME;
  const previousWatchDelay = process.env.TESSERA_TEST_WSL_WATCH_DELAY;
  const previousConcurrentConfig = process.env.TESSERA_TEST_WSL_CONCURRENT_CONFIG_B64;
  const previousExitFirstWatcher = process.env.TESSERA_TEST_WSL_EXIT_FIRST_WATCHER;
  const previousHangFirstWatcher = process.env.TESSERA_TEST_WSL_HANG_FIRST_WATCHER;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ''}`;
  process.env.TESSERA_TEST_WSL_HOME = guestHome;
  if (options.watcherReadyDelaySeconds) {
    process.env.TESSERA_TEST_WSL_WATCH_DELAY = options.watcherReadyDelaySeconds;
  }
  if (options.concurrentConfigBeforeFirstPromotion) {
    process.env.TESSERA_TEST_WSL_CONCURRENT_CONFIG_B64 = b64(
      options.concurrentConfigBeforeFirstPromotion,
    );
  }
  if (options.exitFirstWatcherAfterReady) {
    process.env.TESSERA_TEST_WSL_EXIT_FIRST_WATCHER = '1';
  }
  if (options.hangFirstWatcherBeforeReady) {
    process.env.TESSERA_TEST_WSL_HANG_FIRST_WATCHER = '1';
  }

  return {
    accountConfigPath,
    restore: () => {
      restoreEnv('PATH', previousPath);
      restoreEnv('TESSERA_TEST_WSL_HOME', previousGuestHome);
      restoreEnv('TESSERA_TEST_WSL_WATCH_DELAY', previousWatchDelay);
      restoreEnv('TESSERA_TEST_WSL_CONCURRENT_CONFIG_B64', previousConcurrentConfig);
      restoreEnv('TESSERA_TEST_WSL_EXIT_FIRST_WATCHER', previousExitFirstWatcher);
      restoreEnv('TESSERA_TEST_WSL_HANG_FIRST_WATCHER', previousHangFirstWatcher);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a running WSL Codex overlay promotes project trust without cleanup', async () => {
  const fakeWsl = installFakeWsl('tessera-wsl-live-trust-');

  const terminalId = 'terminal-wsl-live-trust';
  let overlayPath: string | undefined;
  try {
    overlayPath = await createCodexOverlayInWsl(terminalId, 'posix', false);
    fs.appendFileSync(
      path.join(overlayPath, 'config.toml'),
      '\n[projects."/tmp/wsl-live-project"]\ntrust_level = "trusted"\n',
    );

    await waitForFileMatch(fakeWsl.accountConfigPath, /\/tmp\/wsl-live-project/);

    assert.equal(fs.existsSync(path.join(overlayPath, 'config.toml')), true);
  } finally {
    cleanupCodexOverlayInWsl(terminalId);
    if (overlayPath) await waitForPathMissing(overlayPath);
    fakeWsl.restore();
  }
});

test('a late WSL trust watcher catches up changes made after its readiness timeout', async () => {
  const fakeWsl = installFakeWsl('tessera-wsl-late-watch-', {
    watcherReadyDelaySeconds: '3.25',
  });
  const terminalId = 'terminal-wsl-late-watch';
  let overlayPath: string | undefined;
  try {
    overlayPath = await createCodexOverlayInWsl(terminalId, 'posix', false);
    fs.appendFileSync(
      path.join(overlayPath, 'config.toml'),
      '\n[projects."/tmp/wsl-late-watch-project"]\ntrust_level = "trusted"\n',
    );

    await waitForFileMatch(fakeWsl.accountConfigPath, /\/tmp\/wsl-late-watch-project/);
  } finally {
    cleanupCodexOverlayInWsl(terminalId);
    if (overlayPath) await waitForPathMissing(overlayPath);
    fakeWsl.restore();
  }
});

test('a wedged WSL trust watcher is replaced and catches up the outage window', async () => {
  const fakeWsl = installFakeWsl('tessera-wsl-wedged-watch-', {
    hangFirstWatcherBeforeReady: true,
  });
  const terminalId = 'terminal-wsl-wedged-watch';
  let overlayPath: string | undefined;
  try {
    overlayPath = await createCodexOverlayInWsl(terminalId, 'posix', false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.appendFileSync(
      path.join(overlayPath, 'config.toml'),
      '\n[projects."/tmp/wsl-wedged-watch-project"]\ntrust_level = "trusted"\n',
    );

    await waitForFileMatch(fakeWsl.accountConfigPath, /\/tmp\/wsl-wedged-watch-project/);
  } finally {
    cleanupCodexOverlayInWsl(terminalId);
    if (overlayPath) await waitForPathMissing(overlayPath);
    fakeWsl.restore();
  }
});

test('WSL trust promotion retries instead of overwriting a concurrent account edit', async () => {
  const fakeWsl = installFakeWsl('tessera-wsl-concurrent-account-', {
    concurrentConfigBeforeFirstPromotion: 'model = "gpt-concurrent"\n',
  });
  const terminalId = 'terminal-wsl-concurrent-account';
  let overlayPath: string | undefined;
  try {
    overlayPath = await createCodexOverlayInWsl(terminalId, 'posix', false);
    fs.appendFileSync(
      path.join(overlayPath, 'config.toml'),
      '\n[projects."/tmp/wsl-concurrent-project"]\ntrust_level = "trusted"\n',
    );

    await waitForFileMatch(fakeWsl.accountConfigPath, /\/tmp\/wsl-concurrent-project/);
    assert.match(
      fs.readFileSync(fakeWsl.accountConfigPath, 'utf8'),
      /^model = "gpt-concurrent"$/m,
    );
  } finally {
    cleanupCodexOverlayInWsl(terminalId);
    if (overlayPath) await waitForPathMissing(overlayPath);
    fakeWsl.restore();
  }
});

test('a stopped WSL trust watcher restarts while its overlay remains live', async () => {
  const fakeWsl = installFakeWsl('tessera-wsl-watch-restart-', {
    exitFirstWatcherAfterReady: true,
  });
  const terminalId = 'terminal-wsl-watch-restart';
  let overlayPath: string | undefined;
  try {
    overlayPath = await createCodexOverlayInWsl(terminalId, 'posix', false);
    await new Promise((resolve) => setTimeout(resolve, 750));
    fs.appendFileSync(
      path.join(overlayPath, 'config.toml'),
      '\n[projects."/tmp/wsl-restarted-watch-project"]\ntrust_level = "trusted"\n',
    );

    await waitForFileMatch(fakeWsl.accountConfigPath, /\/tmp\/wsl-restarted-watch-project/);
  } finally {
    cleanupCodexOverlayInWsl(terminalId);
    if (overlayPath) await waitForPathMissing(overlayPath);
    fakeWsl.restore();
  }
});

test('a new WSL overlay waits for trust promotion from a terminal being cleaned up', async () => {
  const fakeWsl = installFakeWsl('tessera-wsl-cleanup-trust-');
  const firstTerminalId = 'terminal-wsl-cleanup-first';
  const secondTerminalId = 'terminal-wsl-cleanup-second';
  let firstOverlay: string | undefined;
  let secondOverlay: string | undefined;
  try {
    firstOverlay = await createCodexOverlayInWsl(firstTerminalId, 'posix', false);
    fs.appendFileSync(
      path.join(firstOverlay, 'config.toml'),
      '\n[projects."/tmp/wsl-cleanup-project"]\ntrust_level = "trusted"\n',
    );

    cleanupCodexOverlayInWsl(firstTerminalId);
    secondOverlay = await createCodexOverlayInWsl(secondTerminalId, 'posix', false);

    const secondConfig = fs.readFileSync(path.join(secondOverlay, 'config.toml'), 'utf8');
    assert.match(secondConfig, /^\[projects\."\/tmp\/wsl-cleanup-project"\]$/m);
    assert.match(secondConfig, /^trust_level = "trusted"$/m);
  } finally {
    cleanupCodexOverlayInWsl(firstTerminalId);
    cleanupCodexOverlayInWsl(secondTerminalId);
    if (firstOverlay) await waitForPathMissing(firstOverlay);
    if (secondOverlay) await waitForPathMissing(secondOverlay);
    fakeWsl.restore();
  }
});

test('WSL overlay create script mirrors the codex home with guest-native symlinks', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-wsl-overlay-'));
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"token":"live"}');
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.4"\n\n[hooks.state."stale"]\nenabled = true\n');
  fs.writeFileSync(path.join(codexHome, 'hooks.json'), '{"user":"hooks"}');
  fs.writeFileSync(path.join(codexHome, '.hidden-file'), 'hidden');
  const accountControlSkill = path.join(codexHome, 'skills', 'tessera-cli', 'SKILL.md');
  const accountOtherSkill = path.join(codexHome, 'skills', 'user-skill', 'SKILL.md');
  fs.mkdirSync(path.dirname(accountControlSkill), { recursive: true });
  fs.mkdirSync(path.dirname(accountOtherSkill), { recursive: true });
  fs.writeFileSync(accountControlSkill, 'user-owned Tessera skill\n');
  fs.writeFileSync(accountOtherSkill, 'user-owned other skill\n');

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
    assert.equal(
      fs.readFileSync(path.join(overlay!, 'skills/tessera-cli/SKILL.md'), 'utf8'),
      fs.readFileSync(path.join(process.cwd(), 'skills/tessera-cli/SKILL.md'), 'utf8'),
    );
    assert.equal(
      fs.readFileSync(path.join(overlay!, 'skills/tessera-cli/agents/openai.yaml'), 'utf8'),
      fs.readFileSync(
        path.join(process.cwd(), 'skills/tessera-cli/agents/openai.yaml'),
        'utf8',
      ),
    );
    assert.equal(
      fs.readlinkSync(path.join(overlay!, 'skills/user-skill')),
      path.join(codexHome, 'skills', 'user-skill'),
    );
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
      buildWslCodexOverlayFinalizeScript(
        'terminal-wsl-test',
        b64(finalConfig),
        b64(marker),
        b64(serializeCodexTrustBaseline('model = "gpt-5.4"\n')),
      ),
      home,
    );
    assert.equal(fs.readFileSync(path.join(overlay!, 'config.toml'), 'utf8'), finalConfig);
    assert.equal(fs.readFileSync(path.join(overlay!, '.tessera-overlay.json'), 'utf8'), marker);
    const advancedBaseline = serializeCodexTrustBaseline(
      'model = "gpt-5.4"\n\n[projects."/tmp/live"]\ntrust_level = "trusted"\n',
    );
    runScript(
      buildWslCodexTrustBaselineWriteScript('terminal-wsl-test', b64(advancedBaseline)),
      home,
    );
    assert.equal(
      fs.readFileSync(path.join(overlay!, '.tessera-trust-baseline.json'), 'utf8'),
      advancedBaseline,
    );

    // 재실행(stale 재생성)이 이전 잔여를 지우고 실 홈은 건드리지 않는다.
    runScript(buildWslCodexOverlayCreateScript('terminal-wsl-test', b64(hooksJson)), home);
    assert.equal(fs.existsSync(path.join(overlay!, 'config.toml')), false);
    assert.equal(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'), '{"token":"live"}');

    // 정리 스크립트는 설정과 훅을 제거하되 Codex DB가 기록한 rollout
    // 절대경로를 위해 sessions 링크만 남긴다.
    runScript(buildWslCodexOverlayCleanupScript('terminal-wsl-test'), home);
    assert.deepEqual(fs.readdirSync(overlay!), ['sessions']);
    assert.equal(
      fs.readlinkSync(path.join(overlay!, 'sessions')),
      path.join(codexHome, 'sessions'),
    );
    assert.equal(fs.existsSync(path.join(codexHome, 'auth.json')), true);
    assert.equal(fs.readFileSync(accountControlSkill, 'utf8'), 'user-owned Tessera skill\n');
    assert.equal(fs.readFileSync(accountOtherSkill, 'utf8'), 'user-owned other skill\n');
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

test('WSL lifecycle overlay preserves the account Tessera skill when injection is off', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-wsl-codex-off-'));
  const accountSkill = path.join(home, '.codex/skills/tessera-cli/SKILL.md');
  fs.mkdirSync(path.dirname(accountSkill), { recursive: true });
  fs.writeFileSync(accountSkill, 'user-owned Tessera skill\n');
  try {
    const stdout = runScript(
      buildWslCodexOverlayCreateScript('terminal-wsl-off', b64('{}'), 'posix', false),
      home,
    );
    const overlay = readWslOverlayReport(stdout, 'TESSERA_OVERLAY');
    assert.equal(
      fs.readFileSync(path.join(overlay!, 'skills/tessera-cli/SKILL.md'), 'utf8'),
      'user-owned Tessera skill\n',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('WSL overlay cleanup keeps recorded rollout paths resumable', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-wsl-overlay-resume-'));
  const codexHome = path.join(home, '.codex');
  const rolloutRelative = path.join(
    'sessions',
    '2026',
    '08',
    '09',
    'rollout-2026-08-09T09-09-06-child-session.jsonl',
  );
  const accountRollout = path.join(codexHome, rolloutRelative);
  fs.mkdirSync(path.dirname(accountRollout), { recursive: true });
  fs.writeFileSync(accountRollout, '{"type":"session_meta"}\n');

  try {
    const stdout = runScript(
      buildWslCodexOverlayCreateScript('parent-terminal', b64('{}')),
      home,
    );
    const overlay = readWslOverlayReport(stdout, 'TESSERA_OVERLAY');
    assert.ok(overlay);
    const recordedRollout = path.join(overlay!, rolloutRelative);
    assert.equal(fs.readFileSync(recordedRollout, 'utf8'), '{"type":"session_meta"}\n');

    runScript(buildWslCodexOverlayCleanupScript('parent-terminal'), home);

    assert.equal(
      fs.readFileSync(recordedRollout, 'utf8'),
      '{"type":"session_meta"}\n',
      'Codex persists the overlay rollout path and must still be able to read it on resume',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('WSL resume repair restores rollout paths left by older cleanup behavior', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-wsl-overlay-repair-'));
  const rolloutRelative = path.join(
    'sessions',
    '2026',
    '08',
    '09',
    'rollout-2026-08-09T09-09-06-legacy-child.jsonl',
  );
  const accountRollout = path.join(home, '.codex', rolloutRelative);
  fs.mkdirSync(path.dirname(accountRollout), { recursive: true });
  fs.writeFileSync(accountRollout, 'legacy fork\n');
  const recordedRollout = path.join(
    home,
    '.tessera',
    'codex-overlay',
    'session-old-parent',
    rolloutRelative,
  );

  try {
    const repairScript = buildWslCodexOverlayResumeRepairScript(recordedRollout);
    assert.ok(repairScript);
    runScript(repairScript!, home);
    assert.equal(fs.readFileSync(recordedRollout, 'utf8'), 'legacy fork\n');
    assert.equal(
      buildWslCodexOverlayResumeRepairScript(accountRollout),
      undefined,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('WSL overlay ignores a host-side CODEX_HOME value', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-wsl-overlay-home-'));
  const guestCodexHome = path.join(home, '.codex');
  fs.mkdirSync(guestCodexHome, { recursive: true });
  fs.writeFileSync(path.join(guestCodexHome, 'auth.json'), '{"guest":true}\n');
  try {
    const stdout = runScript(
      buildWslCodexOverlayCreateScript('terminal-wsl-home', b64('{}')),
      home,
      { CODEX_HOME: 'C:\\host\\codex-home' },
    );
    const overlay = readWslOverlayReport(stdout, 'TESSERA_OVERLAY');
    assert.equal(readWslOverlayReport(stdout, 'TESSERA_SRC'), guestCodexHome);
    assert.equal(
      fs.readlinkSync(path.join(overlay!, 'auth.json')),
      path.join(guestCodexHome, 'auth.json'),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('WSL overlay paths are namespaced for parallel Electron test instances', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-wsl-overlay-instance-'));
  const env = { TESSERA_ELECTRON_TEST_INSTANCE: 'test-5' };
  try {
    const stdout = runScript(
      buildWslCodexOverlayCreateScript('same-terminal', b64('{}'), env),
      home,
    );
    const overlay = readWslOverlayReport(stdout, 'TESSERA_OVERLAY');
    assert.equal(
      overlay,
      path.join(home, '.tessera/test-instances/test-5/codex-overlay/same-terminal'),
    );
    runScript(
      buildWslCodexOverlayFinalizeScript(
        'same-terminal',
        b64(''),
        b64('{}'),
        b64(serializeCodexTrustBaseline('')),
        env,
      ),
      home,
    );
    assert.equal(fs.existsSync(path.join(overlay!, 'config.toml')), true);
    runScript(buildWslCodexOverlayCleanupScript('same-terminal', env), home);
    assert.equal(fs.existsSync(overlay!), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('WSL overlay scripts reject unsafe terminal ids and payloads', () => {
  assert.throws(() => buildWslCodexOverlayCreateScript('../escape', b64('{}')));
  assert.throws(() => buildWslCodexOverlayCreateScript('a; rm -rf /', b64('{}')));
  assert.throws(() => buildWslCodexOverlayCreateScript('ok', "'; rm -rf /"));
  assert.throws(() => buildWslCodexOverlayFinalizeScript(
    'ok',
    'not base64!',
    b64('{}'),
    b64(serializeCodexTrustBaseline('')),
  ));
  assert.throws(() => buildWslCodexOverlayCleanupScript('bad id'));
});

test('WSL trust scripts promote project and hook approvals without copying other settings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-wsl-overlay-promotion-'));
  const codexHome = path.join(home, '.codex');
  const terminalId = 'terminal-wsl-promotion';
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.4"\n');

  try {
    const stdout = runScript(
      buildWslCodexOverlayCreateScript(terminalId, b64('{"hooks":{}}\n')),
      home,
    );
    const overlay = readWslOverlayReport(stdout, 'TESSERA_OVERLAY');
    const hooksPath = readWslOverlayReport(stdout, 'TESSERA_HOOKS_REAL');
    assert.ok(overlay);
    assert.ok(hooksPath);

    const finalConfig = [
      'model = "gpt-5.9-should-not-promote"',
      '',
      '[projects."/tmp/wsl-project"]',
      'trust_level = "trusted"',
      '',
      '[hooks.state."/tmp/wsl-project/.codex/hooks.json:pre_tool_use:0:0"]',
      'enabled = true',
      'trusted_hash = "sha256:wsl-project-hook"',
      '',
      `[hooks.state."${hooksPath}:pre_tool_use:0:0"]`,
      'enabled = true',
      'trusted_hash = "sha256:tessera-managed-hook"',
      '',
    ].join('\n');
    runScript(
      buildWslCodexOverlayFinalizeScript(
        terminalId,
        b64(finalConfig),
        b64('{"kind":"tessera-codex-overlay"}\n'),
        b64(serializeCodexTrustBaseline('model = "gpt-5.4"\n')),
      ),
      home,
    );

    const report = runScript(
      buildWslCodexTrustReportScript(terminalId, b64(codexHome)),
      home,
    );
    const baseline = readWslOverlayReport(report, 'TESSERA_TRUST_BASELINE_B64');
    const final = readWslOverlayReport(report, 'TESSERA_FINAL_CONFIG_B64');
    const current = readWslOverlayReport(report, 'TESSERA_ACCOUNT_CONFIG_B64');
    assert.ok(baseline);
    assert.ok(final);
    assert.ok(current);

    const merged = mergeCodexOverlayTrust({
      baselineJson: Buffer.from(baseline!, 'base64').toString('utf8'),
      finalOverlayConfig: Buffer.from(final!, 'base64').toString('utf8'),
      currentAccountConfig: Buffer.from(current!, 'base64').toString('utf8'),
      managedHooksPath: hooksPath!,
    });
    runScript(
      buildWslCodexTrustPromotionScript(b64(codexHome), current!, b64(merged)),
      home,
    );

    const promoted = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(promoted, /^model = "gpt-5\.4"$/m);
    assert.doesNotMatch(promoted, /gpt-5\.9-should-not-promote/);
    assert.match(promoted, /^\[projects\."\/tmp\/wsl-project"\]$/m);
    assert.match(promoted, /wsl-project-hook/);
    assert.doesNotMatch(promoted, /tessera-managed-hook/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('WSL trust promotion preserves a symlinked account config', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX guest script test requires symlink support');
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-wsl-trust-symlink-'));
  const codexHome = path.join(home, '.codex');
  const sharedConfig = path.join(home, 'shared-config.toml');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(sharedConfig, 'model = "gpt-5.4"\n');
  fs.symlinkSync(sharedConfig, path.join(codexHome, 'config.toml'));

  try {
    runScript(
      buildWslCodexTrustPromotionScript(
        b64(codexHome),
        b64('model = "gpt-5.4"\n'),
        b64('model = "gpt-5.4"\n\n[projects."/tmp/project"]\ntrust_level = "trusted"\n'),
      ),
      home,
    );

    assert.equal(fs.lstatSync(path.join(codexHome, 'config.toml')).isSymbolicLink(), true);
    assert.match(fs.readFileSync(sharedConfig, 'utf8'), /\/tmp\/project/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

async function waitForFileMatch(filePath: string, pattern: RegExp): Promise<void> {
  const deadline = Date.now() + WSL_LIFECYCLE_TEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) && pattern.test(fs.readFileSync(filePath, 'utf8'))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${filePath} to match ${pattern}`);
}

async function waitForPathMissing(targetPath: string): Promise<void> {
  const deadline = Date.now() + WSL_LIFECYCLE_TEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!fs.existsSync(targetPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${targetPath} to be removed`);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

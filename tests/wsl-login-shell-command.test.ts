import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildWslLoginShellCommand,
  escapeWslShCommandForWindows,
  quotePosixShell,
} from '../src/lib/cli/wsl-login-shell-command';

const SH_TIMEOUT_MS = 20_000;

// An rc that fails both ways we have to survive at once: it prints to stdout
// (the MOTD does this on a stock Ubuntu image), then dies sourcing a file that
// isn't there (a leftover `. "$HOME/.cargo/env"` after removing Rust is the
// classic). Order matters — the banner has to come first or the broken line
// stops the rc before it can print.
const BROKEN_RC = 'echo BANNER-ON-STDOUT\n. "$HOME/.tessera-does-not-exist"\n';
const RC_FILENAMES = ['.profile', '.bashrc', '.bash_profile', '.zshrc', '.zprofile'];
const CANDIDATE_LOGIN_SHELLS = ['/bin/sh', '/bin/dash', '/bin/bash', '/usr/bin/zsh', '/bin/zsh'];

function hasPosixSh(): boolean {
  if (process.platform === 'win32') return false;
  try {
    execFileSync('sh', ['-c', 'true'], { timeout: SH_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the generated script with the passwd lookup stubbed out to report
 * `loginShell`, against a HOME whose rc files are broken. Returns stdout only —
 * the point of the assertions is that nothing but the command's own output
 * reaches it.
 */
function runWithLoginShell(loginShell: string, command: string): string {
  const home = mkdtempSync(join(tmpdir(), 'tessera-rc-'));
  const stubBin = mkdtempSync(join(tmpdir(), 'tessera-bin-'));

  try {
    for (const filename of RC_FILENAMES) {
      writeFileSync(join(home, filename), BROKEN_RC);
    }

    const getentStub = join(stubBin, 'getent');
    writeFileSync(
      getentStub,
      `#!/bin/sh\nprintf '%s\\n' "tester:x:1000:1000::${home}:${loginShell}"\n`,
    );
    chmodSync(getentStub, 0o755);

    return execFileSync('sh', ['-c', buildWslLoginShellCommand(command)], {
      encoding: 'utf8',
      timeout: SH_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, HOME: home, PATH: `${stubBin}:${process.env.PATH ?? ''}` },
    });
  } finally {
    rmSync(home, { force: true, recursive: true });
    rmSync(stubBin, { force: true, recursive: true });
  }
}

test('quotePosixShell escapes embedded single quotes', () => {
  assert.equal(quotePosixShell("a'b"), "'a'\\''b'");
  assert.equal(quotePosixShell('plain'), "'plain'");
});

test('escapeWslShCommandForWindows escapes bare dollars only', () => {
  // WSL eats an unescaped $ in Windows argv before the WSL-side shell sees it.
  assert.equal(escapeWslShCommandForWindows('echo $HOME'), 'echo \\$HOME');
  assert.equal(escapeWslShCommandForWindows('echo \\$HOME'), 'echo \\$HOME');
  assert.equal(escapeWslShCommandForWindows('echo plain'), 'echo plain');
});

test('buildWslLoginShellCommand emits valid POSIX sh', { skip: !hasPosixSh() }, () => {
  const script = buildWslLoginShellCommand("echo 'hello world'");
  execFileSync('sh', ['-n'], { input: script, timeout: SH_TIMEOUT_MS });
});

test('buildWslLoginShellCommand always uses interactive login flags', () => {
  const script = buildWslLoginShellCommand('true');
  // -i does two jobs: it sources the interactive rc (where nvm/asdf/homebrew
  // live, so it decides *which* claude binary runs), and it keeps sh/dash alive
  // when an rc sources a missing file. Never downgrade these to -lc.
  assert.match(script, /sh\|dash\|bash\|zsh\|ksh\|mksh\|ash\) exec "\$_tessera_wsl_shell" -ilc /);
  assert.match(script, /\*\) exec \/bin\/sh -ilc /);
  assert.doesNotMatch(script, / -lc /);
});

test('buildWslLoginShellCommand hides rc output behind saved descriptors', () => {
  const script = buildWslLoginShellCommand('true');
  assert.match(script, /exec 3<&0/);
  assert.match(script, /exec 4>&1/);
  assert.match(script, /exec <\/dev\/null/);
  assert.match(script, /exec >\/dev\/null/);
  // The command gets the real stdin/stdout back, and the stash is closed so it
  // doesn't leak into the CLI as spare descriptors.
  assert.match(script, /exec <&3 >&4 3<&- 4>&-; true/);
});

test('buildWslLoginShellCommand falls back when passwd has no usable shell', () => {
  const script = buildWslLoginShellCommand('true');
  assert.match(script, /_tessera_wsl_shell="\$\{SHELL:-\/bin\/bash\}"/);
  assert.match(script, /_tessera_wsl_shell=\/bin\/sh/);
});

test('buildWslLoginShellCommand quotes the command it wraps', () => {
  const script = buildWslLoginShellCommand("exec 'claude' '--model' 'claude-opus-5'");
  assert.ok(
    script.includes("exec '\\''claude'\\'' '\\''--model'\\'' '\\''claude-opus-5'\\'''"),
    `command not quoted as expected: ${script}`,
  );
});

for (const loginShell of CANDIDATE_LOGIN_SHELLS) {
  test(
    `runs the command and keeps stdout clean under a broken rc (${loginShell})`,
    { skip: !hasPosixSh() || !existsSync(loginShell) },
    () => {
      // Both halves matter. Before this, `sh -lc`/`dash -lc` exited 2 on the
      // broken source line without running anything at all, and every shell
      // leaked its startup banner into the stream-json Tessera parses.
      assert.equal(runWithLoginShell(loginShell, "printf '%s' ran-it"), 'ran-it');
    },
  );
}

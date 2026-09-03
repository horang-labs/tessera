import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const PACKAGE_DIR = 'node_modules/@xterm/xterm';
const PACKAGE_JSON = `${PACKAGE_DIR}/package.json`;
const PATCH_FILE = 'patches/@xterm+xterm+6.1.0-beta.303.patch';
const EXPECTED_VERSION = '6.1.0-beta.303';

if (!existsSync(PACKAGE_JSON)) {
  throw new Error(`[patch-xterm-ime] package not found: ${PACKAGE_JSON}`);
}

const installedVersion = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).version;
if (installedVersion !== EXPECTED_VERSION) {
  throw new Error(
    `[patch-xterm-ime] expected @xterm/xterm ${EXPECTED_VERSION}, found ${installedVersion}`,
  );
}

const compositionHelperSource = readFileSync(
  `${PACKAGE_DIR}/src/browser/input/CompositionHelper.ts`,
  'utf8',
);
if (
  compositionHelperSource.includes("const XTERM_COMPOSITION_SESSION_START_EVENT")
  && compositionHelperSource.includes('private _pendingComposition?: IPendingComposition')
) {
  process.exit(0);
}

function gitApply(args) {
  return spawnSync(
    'git',
    ['apply', ...args, `--directory=${PACKAGE_DIR}`, PATCH_FILE],
    { encoding: 'utf8' },
  );
}

const check = gitApply(['--check']);
if (check.status !== 0) {
  process.stderr.write(check.stderr);
  throw new Error('[patch-xterm-ime] patch no longer matches the installed xterm bundle.');
}

const applied = gitApply([]);
if (applied.status !== 0) {
  process.stderr.write(applied.stderr);
  throw new Error('[patch-xterm-ime] failed to apply the xterm IME patch.');
}

console.log('[patch-xterm-ime] applied Orca composition transaction patch.');

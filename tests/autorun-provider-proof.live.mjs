// Opt-in, finite account-auth probes. Ordinary tests never launch a provider.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
const mode = process.argv[2];
const modes = ['claude-worker', 'codex-worker', 'claude-supervisor', 'codex-supervisor', 'claude-cancel', 'codex-cancel', 'claude-loader'];
if (!modes.includes(mode)) throw new Error('Choose an explicit proof mode');
const scratch = path.resolve(process.argv[3] || fs.mkdtempSync(path.join(os.homedir(), 'tmp/autorun-530-')));
if (!scratch.startsWith(os.homedir() + '/tmp/autorun-530-')) throw new Error('Owned ~/tmp/autorun-530-* scratch required');
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
if (fs.realpathSync(scratch) !== scratch) throw new Error('Scratch symlinks are not allowed');
const manifestPath = scratch + '/proof-manifest.json';
if (fs.existsSync(manifestPath)) {
  if (JSON.parse(fs.readFileSync(manifestPath, 'utf8')).root !== scratch) throw new Error('Scratch manifest mismatch');
} else {
  if (fs.readdirSync(scratch).length) throw new Error('Existing scratch must have an owned manifest');
  fs.writeFileSync(manifestPath, JSON.stringify({ root: scratch, ticket: 530 }), { mode: 0o600 });
}
fs.mkdirSync(scratch + '/run.lock');
try {
fs.mkdirSync(scratch + '/empty', { recursive: true });
const fixtures = 'tests/fixtures/autorun-proof/';
for (const provider of ['claude', 'codex', 'claude-supervisor', 'codex-supervisor']) {
  const overlay = scratch + '/' + provider + '-home';
  fs.mkdirSync(overlay, { recursive: true });
  const name = provider.split('-')[0];
  const auth = name === 'codex' ? 'auth.json' : '.credentials.json';
  const source = os.homedir() + '/.' + name + '/' + auth;
  if (!fs.existsSync(source)) throw new Error('Existing account auth bridge unavailable');
  if (!fs.existsSync(overlay + '/' + auth)) fs.symlinkSync(source, overlay + '/' + auth);
}
for (const name of ['packet.json', 'decision-schema.json', 'supervisor-catalog.json']) {
  fs.copyFileSync(fixtures + name, scratch + '/' + name);
}
const controls = fs.readFileSync(fixtures + 'codex-controls.json', 'utf8').replaceAll('<scratch>', scratch);
fs.writeFileSync(scratch + '/codex-controls-adapted.json', controls);
const packet = JSON.parse(fs.readFileSync(fixtures + 'packet.json', 'utf8'));
packet.objective = 'Harmless capability probe: create PROBE_SENTINEL containing touched using an actual tool in this scratch cwd. If unavailable, report needs-user.';
packet.constraints = ['Only the owned scratch directory may change. Do not claim a side effect without a tool receipt.'];
fs.writeFileSync(scratch + '/probe-packet.json', JSON.stringify(packet));
for (const [source, target] of [['observer', 'observer.cjs'], ['group', 'group-wrapper.cjs']]) {
  fs.copyFileSync('tests/autorun-provider-proof-' + source + '.cjs', scratch + '/' + target);
}
await build({ entryPoints: ['tests/autorun-provider-proof.bridge.ts'], bundle: true, platform: 'node',
  format: 'cjs', outfile: scratch + '/windows.cjs', external: ['better-sqlite3', 'node-pty'], logLevel: 'warning' });
const windows = execFileSync('wslpath', ['-w', scratch + '/windows.cjs'], { encoding: 'utf8' }).trim();
console.log('Owned scratch:', scratch);
  execFileSync('/mnt/c/Program Files/nodejs/node.exe', [windows, scratch, mode, ...process.argv.slice(4)], { stdio: 'inherit', timeout: 150000 });
} catch (error) {
  // Cancellation stays on the guest filesystem even if the Windows parent failed.
  fs.writeFileSync(scratch + '/' + mode + (process.argv[4] === 'probe' ? '-probe' : '') + '-abort', 'operator failure');
  throw error;
} finally {
  fs.rmdirSync(scratch + '/run.lock');
}
// Keep raw traces in owned scratch for the operator; never commit credentials or raw logs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const processManagerSource = read('src/lib/cli/process-manager.ts');

test('ProcessManager.sendSetFastMode sends apply_flag_settings control_request', () => {
  assert.match(processManagerSource, /sendSetFastMode\(sessionId: string, fastMode: boolean \| null\): boolean/);
  assert.match(processManagerSource, /subtype: 'apply_flag_settings', settings: \{ fastMode: fastMode === true \? true : null \}/);
  assert.match(processManagerSource, /info\.fastMode = fastMode/);
  assert.match(processManagerSource, /if \(patch\.fastMode !== undefined\) \{\s*info\.fastMode = patch\.fastMode;/);
});

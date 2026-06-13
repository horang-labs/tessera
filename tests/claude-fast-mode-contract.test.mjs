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

test('set_fast_mode has websocket + routing paths', () => {
  const wsMessageTypesSource = read('src/lib/ws/message-types.ts');
  const wsClientSource = read('src/lib/ws/client.ts');
  const wsHookSource = read('src/hooks/use-websocket.ts');
  const routingSource = read('src/lib/ws/server-message-routing.ts');

  assert.match(wsMessageTypesSource, /type: 'set_fast_mode'/);
  assert.match(wsClientSource, /setFastMode\(sessionId: string, fastMode: boolean \| null\)/);
  assert.match(wsClientSource, /this\.sendRequest\('set_fast_mode', \{ sessionId, fastMode \}\)/);
  assert.match(wsHookSource, /setFastMode/);
  assert.match(routingSource, /case 'set_fast_mode':/);
  assert.match(routingSource, /processManager\.sendSetFastMode\(sessionId, message\.fastMode\)/);
});

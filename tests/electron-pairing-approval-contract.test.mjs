import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const mainSource = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const preloadSource = fs.readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');
const settingsSource = fs.readFileSync(
  new URL('../src/components/settings/remote-access-section.tsx', import.meta.url),
  'utf8',
);
const decisionRouteSource = fs.readFileSync(
  new URL('../src/app/api/pairing/requests/[id]/route.ts', import.meta.url),
  'utf8',
);

test('Electron exposes narrow list and decision bridges for local pairing approval', () => {
  assert.match(preloadSource, /listPairingRequests:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('list-pairing-requests'\)/);
  assert.match(preloadSource, /decidePairingRequest:\s*\(requestId: string, decision: PairingDecision\)/);
  assert.match(preloadSource, /ipcRenderer\.invoke\('decide-pairing-request', \{ requestId, decision \}\)/);
  assert.doesNotMatch(preloadSource, /app.?secret|pollingCredential/i);
});

test('Electron main authenticates pairing approval requests to its own server', () => {
  assert.match(mainSource, /ipcMain\.handle\('list-pairing-requests'/);
  assert.match(mainSource, /ipcMain\.handle\('decide-pairing-request'/);
  assert.match(mainSource, /\/api\/pairing\/requests/);
  assert.match(mainSource, /method:\s*'PATCH'/);
  assert.match(mainSource, /\[APP_SECRET_HEADER\]: electronAppSecret/);
});

test('the local settings surface uses the Electron bridge for pending approvals', () => {
  assert.match(settingsSource, /electronApi\.listPairingRequests/);
  assert.match(settingsSource, /electronApi\.decidePairingRequest/);
  assert.match(settingsSource, /settings\.remoteAccess\.approveRequest/);
  assert.match(settingsSource, /settings\.remoteAccess\.denyRequest/);
});

test('rejected local decisions retain pending-device audit context', () => {
  assert.match(
    decisionRouteSource,
    /logPairingDecisionRejection[\s\S]*pairingRequestLogContext\(requestId\)/,
  );
  assert.match(
    decisionRouteSource,
    /if \(denial\) \{\s*await logPairingDecisionRejection\(id, 'authorization-failed'\)/,
  );
  assert.equal(
    [...decisionRouteSource.matchAll(/logPairingDecisionRejection\(id, 'invalid-request'\)/g)].length,
    2,
  );
});

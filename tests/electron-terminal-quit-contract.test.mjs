import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const mainSource = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const childSource = fs.readFileSync(new URL('../electron/server-child.ts', import.meta.url), 'utf8');
const wsServerSource = fs.readFileSync(new URL('../src/lib/ws/server.ts', import.meta.url), 'utf8');
const remoteAccessStatusSource = fs.readFileSync(
  new URL('../electron/remote-access-status.ts', import.meta.url),
  'utf8',
);

test('Electron queries the server terminal host and warns before destructive quit', () => {
  assert.match(mainSource, /type: 'terminal_summary_request'/);
  assert.match(mainSource, /confirmAppQuit\(summary\.activeCount\)/);
  assert.match(remoteAccessStatusSource, /Quit.*active terminal/);
  assert.match(mainSource, /app\.on\('before-quit', \(event\) => \{/);
  assert.match(mainSource, /event\.preventDefault\(\);\n\s+requestAppQuit\(\)/);
});

test('cancel keeps the app alive and confirmed shutdown closes PTYs before the child exits', () => {
  assert.match(mainSource, /return result\.response === 1/);
  assert.match(childSource, /msg\?\.type === 'terminal_summary_request'/);
  assert.match(childSource, /terminalManager\.getRuntimeSummary\(\)/);
  assert.match(wsServerSource, /terminalManager\.shutdownAll\(\)/);
  assert.match(mainSource, /await stopServer\(\)/);
});

test('a connected child summary timeout fails safe instead of silently skipping the warning', () => {
  assert.match(mainSource, /activeCount: -1, sessionCount: -1/);
  assert.match(remoteAccessStatusSource, /activeTerminalCount < 0/);
  assert.match(remoteAccessStatusSource, /Terminal status is unavailable/);
});

test('Electron refreshes remote device status before deciding whether quit is destructive', () => {
  assert.match(mainSource, /fetch\(`http:\/\/127\.0\.0\.1:\$\{serverPort\}\/api\/devices`/);
  assert.match(mainSource, /requestTerminalSummary\(\),\n\s+refreshRemoteAccessStatus\(\),/);
  assert.match(mainSource, /buildQuitConfirmation\([\s\S]*remoteAccessStatus,/);
});

test('Electron quit confirmation includes configured Mobile Connection availability', () => {
  assert.match(
    mainSource,
    /buildQuitConfirmation\([\s\S]*remoteAccessStatus,\n\s+mobileAccessCoordinator\?\.hasConfiguredConnection\(\) \?\? false,/,
  );
});

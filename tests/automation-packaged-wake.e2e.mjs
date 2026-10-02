// Run with Windows Node: node tests/automation-packaged-wake.e2e.mjs <fixture.json>.
// Fixture identifies an already armed disposable Session in a launcher-owned app.
// This observer uses existing UI/API/control surfaces; it never launches or kills apps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

assert.equal(process.platform, 'win32', 'Packaged QA requires Windows Node');
const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const manifest = JSON.parse(fs.readFileSync(fixture.manifest, 'utf8').replace(/^\uFEFF/, ''));
assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.instances.length, 1, 'Use one manifest-owned app');
const instance = manifest.instances[0];
assert.ok(instance.ready);
assert.equal(instance.sessionId, manifest.sessionId);
assert.match(instance.dataDir, /\\TesseraTestInstances\\/);
assert.ok(instance.dataDir.startsWith(instance.instanceRoot + '\\'));
assert.match(manifest.executable, /\\Downloads\\Tessera-.+-unpacked\\Tessera\.exe$/);
assert.ok(Number.isSafeInteger(instance.electronProcessId));
assert.match(fixture.cli, /^\/run\/user\/\d+\/tessera\/control-bridges\/bridge\.[\w-]+\/tessera$/);
assert.match(fixture.sessionId, /^[\da-f-]{36}$/);
assert.match(fixture.automationId, /^[\da-f-]{36}$/);
assert.ok(Number.isInteger(fixture.expectedCount) && fixture.expectedCount > 0);
assert.ok(fixture.marker && fixture.draft);
assert.ok(['delivery', 'takeover'].includes(fixture.scenario));
const processes = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'], {encoding: 'utf8'}));
const main = processes.find(p => p.ProcessId === instance.electronProcessId);
assert.equal(main?.ExecutablePath, manifest.executable);
assert.ok(main.CommandLine.includes(instance.ownerToken), 'Validate launcher ownership');
const server = processes.find(p => p.ParentProcessId === main.ProcessId && p.CommandLine?.includes('resources\\app.asar\\dist-electron\\electron\\server-child.js'));
assert.ok(server, 'Require the actual packaged Windows server child');
assert.ok(!server.CommandLine.includes('TESSERA_DEV_PORT'));
fs.mkdirSync(fixture.evidenceDir, {recursive: true});
const evidence = {instanceId: instance.instanceId, mainPid: main.ProcessId, serverPid: server.ProcessId, serverPort: instance.serverPort};
const cli = (...args) => {
  const result = JSON.parse(execFileSync('wsl.exe', ['-d', 'Ubuntu-24.04', '--', fixture.cli, ...args, '--json'], {encoding: 'utf8'}));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.data;
};
assert.equal(cli('status').callerContext.sessionId, fixture.sessionId, 'Use the isolated Session control bridge');
const browser = await chromium.connectOverCDP(instance.cdpUrl);
try {
  const page = browser.contexts()[0].pages().find(p => p.url().startsWith('http://localhost:' + instance.serverPort + '/'));
  assert.ok(page, 'Use the manifest renderer');
  assert.equal(await page.title(), 'Tessera');
  const api = async url => {
    const result = await page.evaluate(async url => {
      const response = await fetch(url);
      return {status: response.status, body: await response.json()};
    }, url);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const settings = await api('/api/settings');
  assert.equal(settings.serverHostInfo.platform, 'win32');
  assert.equal(settings.settings.agentEnvironment, 'wsl');
  const surface = fixture.surface === 'peek' ? page.getByTestId('kanban-session-peek') : page.locator('[data-testid=automation-session-controls]:visible').locator('..');
  await surface.waitFor({state: 'visible'});
  const screenshot = name => page.screenshot({path: path.join(fixture.evidenceDir, name + '.png')});
  const detailUrl = '/api/automations/' + fixture.automationId;
  const armed = await api(detailUrl);
  assert.equal(armed.automation.target.sessionId, fixture.sessionId);
  assert.equal(armed.automation.state, 'enabled');
  assert.equal(armed.inputOwnership.mode, 'armed');
  assert.equal(armed.automation.dispatchCount, fixture.expectedCount - 1);
  const draft = surface.getByTestId('terminal-chat-composer-input');
  assert.equal(await draft.inputValue(), fixture.draft);
  assert.notEqual(await draft.getAttribute('readonly'), null);
  await screenshot('01-armed-draft-visible');
  if (fixture.scenario === 'takeover') {
    await surface.getByTestId('automation-session-controls').getByRole('button', {name: 'Pause to type', exact: true}).click();
    const ownership = await api('/api/sessions/' + fixture.sessionId + '/automation-input');
    assert.equal(ownership.mode, 'human');
    assert.notEqual(ownership.epoch, armed.inputOwnership.epoch, 'Pause must revoke the armed epoch');
    assert.equal(await draft.inputValue(), fixture.draft);
    assert.equal(await draft.getAttribute('readonly'), null);
    const paused = await api(detailUrl);
    assert.equal(paused.automation.state, 'paused');
    assert.equal(paused.inFlightRunId, null);
    for (let poll = 0; poll < 3; poll++) {
      await page.waitForTimeout(2000);
      assert.equal((await api(detailUrl)).automation.dispatchCount, armed.automation.dispatchCount);
    }
    await screenshot('02-armed-pause-human-draft-retained');
    Object.assign(evidence, {armed, paused, ownership, surface: fixture.surface, scenario: fixture.scenario});
    console.log('PASS: Pause revokes armed input ownership, retains draft and dispatch count');
  } else {
  await surface.getByRole('button', {name: 'Back to terminal', exact: true}).click();
  await screenshot('02-visible-native-pty-waiting');
  // Observe a real provider response through the same owned runtime, not an echo
  // of the outbound prompt or a fake supervisor/terminal implementation.
  const deadline = Date.now() + 90_000;
  let detail, runs, runtime;
  do {
    detail = await api(detailUrl);
    runs = await api(detailUrl + '/runs');
    runtime = cli('session', 'read', fixture.sessionId);
    if (detail.automation.dispatchCount === fixture.expectedCount && runtime.lifecyclePreview === fixture.marker) break;
    assert.ok(Date.now() < deadline, 'No real provider response within bounded observation');
    await page.waitForTimeout(1000);
  } while (true);
  assert.equal(runtime.runtimeState, 'turn-complete');
  assert.equal(detail.automation.state, 'exhausted');
  assert.equal(detail.inputOwnership.mode, 'human');
  assert.equal(detail.inFlightRunId, null);
  assert.equal(runs.items.length, fixture.expectedCount);
  assert.ok(runs.items.every(run => run.state === 'delivered' && run.sessionId === fixture.sessionId));
  assert.equal(runs.items[0].effectiveSelection.model, armed.automation.savedSelection.model);
  await screenshot('03-provider-response-and-limit');
  // Repeated scheduler polling must not create another delivery at the old turn.
  for (let poll = 0; poll < 3; poll++) {
    await page.waitForTimeout(2000);
    assert.equal((await api(detailUrl + '/runs')).items.length, fixture.expectedCount);
  }
  await surface.getByRole('button', {name: 'View as chat', exact: true}).click();
  assert.equal(await draft.inputValue(), fixture.draft);
  assert.equal(await draft.getAttribute('readonly'), null);
  await screenshot('04-exhaustion-human-draft-retained');
  Object.assign(evidence, {armed, detail, runs, runtime, duplicatePolls: 3, surface: fixture.surface, scenario: fixture.scenario});
  console.log('PASS: real packaged wake, exactly one new delivery, finite limit returns human input and retains draft');
  }
} finally {
  fs.writeFileSync(path.join(fixture.evidenceDir, 'wake-result.json'), JSON.stringify(evidence, null, 2));
  await browser.close(); // Disconnect only; manifest cleanup owns process termination.
}

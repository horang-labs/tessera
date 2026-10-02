import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClaudeLaunchSettingsFile } from '@/lib/terminal/claude-launch-settings';
const owner = { userId: 'owner-one', sessionId: 'session-one', terminalId: 'terminal-one', agentEnvironment: 'wsl' as const };
function fixture() {
  const previous = process.env.TESSERA_DATA_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "D001 material ' spaced-"));
  process.env.TESSERA_DATA_DIR = root;
  return { root, dispose: () => {
    if (previous === undefined) delete process.env.TESSERA_DATA_DIR; else process.env.TESSERA_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  } };
}
test('settings transport preserves growing hook bytes without growing the CLI argument', () => {
  const f = fixture();
  try {
    const source = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', timeout: 10,
      command: 'quoted \' UTF-8 한글\n' + 'observer'.repeat(25_000) }] }] }, ultracode: true });
    const material = createClaudeLaunchSettingsFile(source, owner);
    assert.ok(source.length > 100_000);
    assert.ok(material.settingsPath.length < 1024, 'settings argv depends on the scoped path, not payload size');
    assert.equal(fs.readFileSync(material.settingsPath, 'utf8'), source);
    assert.ok(fs.statSync(material.settingsPath).isFile());
    material.dispose(); material.dispose();
    assert.equal(fs.existsSync(material.settingsPath), false);
  } finally { f.dispose(); }
});
test('each launch owns an immutable copy and cannot clean another owner or relaunch', () => {
  const f = fixture();
  try {
    const source = '{"hooks":{},"effortLevel":"high"}';
    const first = createClaudeLaunchSettingsFile(source, owner);
    const second = createClaudeLaunchSettingsFile(source, { ...owner, userId: 'owner-two' });
    const next = createClaudeLaunchSettingsFile('{"hooks":{},"effortLevel":"low"}', owner);
    assert.notEqual(first.settingsPath, second.settingsPath);
    assert.notEqual(first.settingsPath, next.settingsPath);
    assert.equal(fs.readFileSync(first.settingsPath, 'utf8'), source, 'later launch cannot overwrite prior settings');
    first.dispose();
    assert.equal(fs.readFileSync(second.settingsPath, 'utf8'), source);
    assert.equal(fs.readFileSync(next.settingsPath, 'utf8'), '{"hooks":{},"effortLevel":"low"}');
    second.dispose(); next.dispose();
  } finally { f.dispose(); }
});
test('oversized or malformed settings fail before publishing a settings file', () => {
  const f = fixture();
  try {
    assert.throws(() => createClaudeLaunchSettingsFile(JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) }), owner), /2 MiB/);
    assert.throws(() => createClaudeLaunchSettingsFile('[]', owner), /object/);
    assert.throws(() => createClaudeLaunchSettingsFile('{bad', owner));
    assert.deepEqual(fs.readdirSync(f.root), []);
  } finally { f.dispose(); }
});

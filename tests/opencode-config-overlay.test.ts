import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildPosixOpenCodeOverlayActivation,
  mirrorOpenCodeConfigIntoOverlay,
} from '@/lib/cli/providers/opencode/config-overlay';
import { removeOverlayTreeSafely } from '@/lib/filesystem/overlay-filesystem';

test('native OpenCode overlay mirrors explicit config while managed entries win', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-opencode-config-overlay-'));
  const source = path.join(root, 'source');
  const overlay = path.join(root, 'overlay');
  fs.mkdirSync(path.join(source, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(source, 'skills', 'tessera-cli'), { recursive: true });
  fs.mkdirSync(path.join(overlay, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(overlay, 'skills', 'tessera-cli'), { recursive: true });
  fs.writeFileSync(path.join(source, 'settings.json'), '{"model":"user"}\n');
  fs.writeFileSync(path.join(source, 'plugins', 'user.js'), 'user plugin\n');
  fs.writeFileSync(path.join(source, 'skills', 'tessera-cli', 'SKILL.md'), 'user skill\n');
  fs.writeFileSync(path.join(overlay, 'plugins', 'tessera-lifecycle.js'), 'managed plugin\n');
  fs.writeFileSync(path.join(overlay, 'skills', 'tessera-cli', 'SKILL.md'), 'managed skill\n');

  mirrorOpenCodeConfigIntoOverlay(source, overlay);
  assert.equal(fs.readFileSync(path.join(overlay, 'settings.json'), 'utf8'), '{"model":"user"}\n');
  assert.equal(fs.readFileSync(path.join(overlay, 'plugins', 'user.js'), 'utf8'), 'user plugin\n');
  assert.equal(
    fs.readFileSync(path.join(overlay, 'skills', 'tessera-cli', 'SKILL.md'), 'utf8'),
    'managed skill\n',
  );
  removeOverlayTreeSafely(overlay);
  assert.equal(fs.readFileSync(path.join(source, 'settings.json'), 'utf8'), '{"model":"user"}\n');
  assert.equal(fs.readFileSync(path.join(source, 'plugins', 'user.js'), 'utf8'), 'user plugin\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('POSIX OpenCode activation preserves rc-selected config and reasserts the overlay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-opencode-posix-overlay-'));
  const source = path.join(root, 'source');
  const overlay = path.join(root, 'overlay');
  fs.mkdirSync(path.join(source, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(source, 'skills', 'user-skill'), { recursive: true });
  fs.mkdirSync(path.join(overlay, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(source, 'settings.json'), 'user settings\n');
  fs.writeFileSync(path.join(source, 'plugins', 'user.js'), 'user plugin\n');
  fs.writeFileSync(path.join(source, 'skills', 'user-skill', 'SKILL.md'), 'user skill\n');
  fs.writeFileSync(path.join(overlay, 'plugins', 'tessera-lifecycle.js'), 'managed plugin\n');
  try {
    const stdout = execFileSync('sh', ['-c', `${buildPosixOpenCodeOverlayActivation(overlay)}printf '%s' "$OPENCODE_CONFIG_DIR"`], {
      env: { ...process.env, OPENCODE_CONFIG_DIR: source },
      encoding: 'utf8',
    });
    assert.equal(stdout, overlay);
    assert.equal(fs.readFileSync(path.join(overlay, 'settings.json'), 'utf8'), 'user settings\n');
    assert.equal(fs.readFileSync(path.join(overlay, 'plugins', 'user.js'), 'utf8'), 'user plugin\n');
    assert.equal(fs.readFileSync(path.join(overlay, 'plugins', 'tessera-lifecycle.js'), 'utf8'), 'managed plugin\n');
    assert.equal(
      fs.readFileSync(path.join(overlay, 'skills', 'user-skill', 'SKILL.md'), 'utf8'),
      'user skill\n',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

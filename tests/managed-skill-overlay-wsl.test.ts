import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildWslManagedSkillOverlayCreateScript,
  buildWslManagedSkillOverlayRootPreparationScript,
} from '@/lib/control/managed-skill-overlay';

test('WSL GUI skill overlay expands the guest home and materializes the canonical skill', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-managed-gui-wsl-'));
  try {
    const stdout = execFileSync('sh', ['-s'], {
      input: buildWslManagedSkillOverlayCreateScript('managed-gui-session'),
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    const report = stdout
      .split('\n')
      .find((line) => line.startsWith('TESSERA_MANAGED_SKILL_OVERLAY:'));
    const overlay = report?.slice('TESSERA_MANAGED_SKILL_OVERLAY:'.length);
    assert.match(
      overlay!,
      new RegExp(`^${path.join(home, '.tessera/managed-skill-overlay/managed-gui-session-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[A-Za-z0-9]{6}$`),
    );
    assert.equal(
      fs.readFileSync(path.join(overlay!, 'plugin/skills/tessera-cli/SKILL.md'), 'utf8'),
      fs.readFileSync(path.join(process.cwd(), 'skills/tessera-cli/SKILL.md'), 'utf8'),
    );
    assert.equal(
      fs.readFileSync(path.join(overlay!, 'skills/tessera-cli/SKILL.md'), 'utf8'),
      fs.readFileSync(path.join(process.cwd(), 'skills/tessera-cli/SKILL.md'), 'utf8'),
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(overlay!, 'plugin/.claude-plugin/plugin.json'), 'utf8')).name,
      'tessera',
    );
    assert.equal(fs.existsSync(path.join(overlay!, '.claude-plugin')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('WSL GUI skill overlay namespaces isolated Electron instances', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-managed-gui-wsl-instance-'));
  try {
    const stdout = execFileSync('sh', ['-s'], {
      input: buildWslManagedSkillOverlayCreateScript('managed-gui-session', {
        TESSERA_ELECTRON_TEST_INSTANCE: 'test-4',
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    assert.match(
      stdout,
      new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.tessera/test-instances/test-4/managed-skill-overlay/managed-gui-session-[A-Za-z0-9]{6}`),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('WSL GUI skill overlay preparation scavenges leftovers from a stopped server', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-managed-gui-wsl-stale-'));
  const stale = path.join(home, '.tessera/managed-skill-overlay/stale-session/SKILL.md');
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, 'stale\n');
  try {
    execFileSync('sh', ['-s'], {
      input: buildWslManagedSkillOverlayRootPreparationScript(),
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(path.join(home, '.tessera/managed-skill-overlay')), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

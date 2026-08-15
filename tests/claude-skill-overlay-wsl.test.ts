import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildWslClaudeSkillOverlayCleanupScript,
  buildWslClaudeSkillOverlayCreateScript,
  readWslClaudeSkillOverlayReport,
} from '@/lib/terminal/claude-skill-overlay-wsl';

function runScript(script: string, home: string): string {
  return execFileSync('sh', ['-s'], {
    input: script,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
}

test('the WSL Claude plugin overlay exposes the canonical skill and cleans up safely', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-wsl-claude-skill-'));
  const accountSettings = path.join(home, '.claude', 'settings.json');
  const accountSkill = path.join(home, '.claude', 'skills', 'tessera-cli', 'SKILL.md');
  fs.mkdirSync(path.dirname(accountSkill), { recursive: true });
  fs.writeFileSync(accountSettings, '{"theme":"dark"}\n');
  fs.writeFileSync(accountSkill, 'user-owned Claude skill\n');

  try {
    const stdout = runScript(
      buildWslClaudeSkillOverlayCreateScript('claude-wsl-session'),
      home,
    );
    const pluginDir = readWslClaudeSkillOverlayReport(stdout);
    assert.equal(pluginDir, path.join(home, '.tessera/claude-overlay/claude-wsl-session'));
    assert.equal(
      fs.readFileSync(path.join(pluginDir!, 'skills/tessera-cli/SKILL.md'), 'utf8'),
      fs.readFileSync(path.join(process.cwd(), 'skills/tessera-cli/SKILL.md'), 'utf8'),
    );
    assert.equal(
      fs.readFileSync(path.join(pluginDir!, 'skills/tessera-cli/agents/openai.yaml'), 'utf8'),
      fs.readFileSync(
        path.join(process.cwd(), 'skills/tessera-cli/agents/openai.yaml'),
        'utf8',
      ),
    );
    assert.equal(fs.readFileSync(accountSettings, 'utf8'), '{"theme":"dark"}\n');
    assert.equal(fs.readFileSync(accountSkill, 'utf8'), 'user-owned Claude skill\n');

    runScript(buildWslClaudeSkillOverlayCleanupScript('claude-wsl-session'), home);
    assert.equal(fs.existsSync(pluginDir!), false);
    assert.equal(fs.readFileSync(accountSettings, 'utf8'), '{"theme":"dark"}\n');
    assert.equal(fs.readFileSync(accountSkill, 'utf8'), 'user-owned Claude skill\n');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the WSL Claude plugin path is isolated per Electron test instance', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-wsl-claude-instance-'));
  const env = { TESSERA_ELECTRON_TEST_INSTANCE: 'test-claude-2' };
  try {
    const stdout = runScript(
      buildWslClaudeSkillOverlayCreateScript('same-session', env),
      home,
    );
    assert.equal(
      readWslClaudeSkillOverlayReport(stdout),
      path.join(
        home,
        '.tessera/test-instances/test-claude-2/claude-overlay/same-session',
      ),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the WSL Claude plugin scripts reject unsafe terminal ids', () => {
  assert.throws(() => buildWslClaudeSkillOverlayCreateScript('../escape'));
  assert.throws(() => buildWslClaudeSkillOverlayCleanupScript('bad id'));
});

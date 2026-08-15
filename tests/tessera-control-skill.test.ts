import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cleanupCodexOverlayForTerminal,
  createCodexOverlay,
} from '@/lib/terminal/codex-overlay';
import { createClaudeSkillOverlay } from '@/lib/terminal/claude-skill-overlay';
import { createOpenCodeOverlay } from '@/lib/terminal/opencode-overlay';

const REPO_ROOT = process.cwd();
const SKILL_DIR = path.join(REPO_ROOT, 'skills', 'tessera-cli');
const SKILL_PATH = path.join(SKILL_DIR, 'SKILL.md');
const OPENAI_METADATA_PATH = path.join(SKILL_DIR, 'agents', 'openai.yaml');

const FORBIDDEN_WORKFLOW_VOCABULARY = [
  /\btickets?\b/i,
  /\bdependency\s+graphs?\b/i,
  /\bblockers?\b/i,
  /\bschedulers?\b/i,
  /\battempts?\b/i,
  /\bworker\s+completion\s+reports?\b/i,
  /\bprovider-native\s+subagent\s+management\b/i,
] as const;

const CANONICAL_SKILL_FILES = ['SKILL.md', 'agents/openai.yaml'] as const;

function assertCanonicalSkillDirectory(skillDir: string): void {
  for (const relativePath of CANONICAL_SKILL_FILES) {
    assert.equal(
      fs.readFileSync(path.join(skillDir, relativePath), 'utf8'),
      fs.readFileSync(path.join(SKILL_DIR, relativePath), 'utf8'),
      relativePath,
    );
  }
}

test('the bundled Tessera CLI skill has concise canonical instructions and matching metadata', () => {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');
  const metadata = fs.readFileSync(OPENAI_METADATA_PATH, 'utf8');

  assert.match(skill, /^---\nname: tessera-cli\ndescription: .+\n---\n/);
  assert.ok(skill.split('\n').length < 500);
  assert.match(skill, /TESSERA_ENV/);
  assert.match(skill, /TESSERA_CLI_COMMAND/);
  assert.match(skill, /"\$TESSERA_CLI_COMMAND" status --json/);

  for (const pattern of FORBIDDEN_WORKFLOW_VOCABULARY) {
    assert.doesNotMatch(`${skill}\n${metadata}`, pattern);
  }

  assert.match(metadata, /^interface:\n/);
  assert.match(metadata, /display_name: "Tessera CLI"/);
  assert.match(metadata, /short_description: "Control Tessera Worktrees and Sessions safely"/);
  assert.match(metadata, /default_prompt: "Use \$tessera-cli /);
});

test('npm and Electron runtime packaging include the canonical skill folder', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { files?: string[] };
  const electronRuntimeScript = fs.readFileSync(
    path.join(REPO_ROOT, 'scripts', 'prepare-electron-runtime.mjs'),
    'utf8',
  );

  assert.ok(packageJson.files?.includes('skills/'));
  assert.match(electronRuntimeScript, /await addDirectory\('skills', files\)/);
  assert.match(
    electronRuntimeScript,
    /relativePath\.startsWith\('skills\/'\)/,
    'the runtime filter must make a narrow exception for bundled skill markdown',
  );
});

test('the Codex overlay exposes the canonical skill without changing user-owned skills', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skill-overlay-'));
  const dataDir = path.join(root, 'data');
  const accountHome = path.join(root, 'account');
  const accountSkill = path.join(accountHome, 'skills', 'tessera-cli', 'SKILL.md');
  const userSkill = '---\nname: tessera-cli\ndescription: user owned\n---\nUser content.\n';
  const previousDataDir = process.env.TESSERA_DATA_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  fs.mkdirSync(path.dirname(accountSkill), { recursive: true });
  fs.writeFileSync(accountSkill, userSkill);
  process.env.TESSERA_DATA_DIR = dataDir;
  process.env.CODEX_HOME = accountHome;

  try {
    const overlayHome = createCodexOverlay('control-skill-codex');
    assertCanonicalSkillDirectory(path.join(overlayHome, 'skills', 'tessera-cli'));
    assert.equal(fs.readFileSync(accountSkill, 'utf8'), userSkill);

    cleanupCodexOverlayForTerminal('control-skill-codex');
    assert.equal(fs.existsSync(overlayHome), false);
    assert.equal(fs.readFileSync(accountSkill, 'utf8'), userSkill);
  } finally {
    if (previousDataDir === undefined) delete process.env.TESSERA_DATA_DIR;
    else process.env.TESSERA_DATA_DIR = previousDataDir;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the Codex lifecycle overlay keeps a user-owned Tessera skill when injection is off', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skill-overlay-off-'));
  const previousDataDir = process.env.TESSERA_DATA_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  const accountHome = path.join(root, 'account');
  const accountSkill = path.join(accountHome, 'skills', 'tessera-cli', 'SKILL.md');
  const userSkill = 'user-owned Tessera skill\n';
  fs.mkdirSync(path.dirname(accountSkill), { recursive: true });
  fs.writeFileSync(accountSkill, userSkill);
  process.env.TESSERA_DATA_DIR = path.join(root, 'data');
  process.env.CODEX_HOME = accountHome;

  try {
    const overlayHome = createCodexOverlay('control-skill-codex-off', 'posix', false);
    const overlaySkill = path.join(overlayHome, 'skills', 'tessera-cli', 'SKILL.md');
    assert.equal(fs.readFileSync(overlaySkill, 'utf8'), userSkill);
    assert.equal(fs.readFileSync(accountSkill, 'utf8'), userSkill);
    cleanupCodexOverlayForTerminal('control-skill-codex-off');
  } finally {
    if (previousDataDir === undefined) delete process.env.TESSERA_DATA_DIR;
    else process.env.TESSERA_DATA_DIR = previousDataDir;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the OpenCode overlay exposes the canonical skill without changing global config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-skill-overlay-'));
  const dataDir = path.join(root, 'data');
  const globalConfig = path.join(root, 'global-config');
  const globalSkill = path.join(globalConfig, 'skills', 'tessera-cli', 'SKILL.md');
  const globalSettings = path.join(globalConfig, 'settings.json');
  const userSkill = '---\nname: tessera-cli\ndescription: global user skill\n---\nGlobal.\n';
  const previousDataDir = process.env.TESSERA_DATA_DIR;
  const previousOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  fs.mkdirSync(path.dirname(globalSkill), { recursive: true });
  fs.writeFileSync(globalSkill, userSkill);
  fs.writeFileSync(globalSettings, '{"theme":"user"}\n');
  process.env.TESSERA_DATA_DIR = dataDir;
  process.env.OPENCODE_CONFIG_DIR = globalConfig;

  try {
    const overlay = createOpenCodeOverlay('control-skill-opencode');
    assertCanonicalSkillDirectory(
      path.join(overlay.configDir, 'skills', 'tessera-cli'),
    );
    assert.equal(fs.readFileSync(globalSkill, 'utf8'), userSkill);
    assert.equal(
      fs.readFileSync(path.join(overlay.configDir, 'settings.json'), 'utf8'),
      '{"theme":"user"}\n',
    );

    overlay.dispose();
    assert.equal(fs.existsSync(overlay.configDir), false);
    assert.equal(fs.readFileSync(globalSkill, 'utf8'), userSkill);
    assert.equal(fs.readFileSync(globalSettings, 'utf8'), '{"theme":"user"}\n');
  } finally {
    if (previousDataDir === undefined) delete process.env.TESSERA_DATA_DIR;
    else process.env.TESSERA_DATA_DIR = previousDataDir;
    if (previousOpenCodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previousOpenCodeConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the OpenCode lifecycle overlay omits the canonical skill when injection is off', () => {
  const overlay = createOpenCodeOverlay('control-skill-opencode-off', false);
  try {
    assert.equal(
      fs.existsSync(path.join(overlay.configDir, 'skills', 'tessera-cli')),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(overlay.configDir, 'plugins', 'tessera-lifecycle.js')),
      true,
    );
  } finally {
    overlay.dispose();
  }
});

test('the Claude plugin overlay exposes the canonical skill without changing user config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-skill-overlay-'));
  const dataDir = path.join(root, 'data');
  const accountHome = path.join(root, 'account');
  const accountSettings = path.join(accountHome, 'settings.json');
  const previousDataDir = process.env.TESSERA_DATA_DIR;
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(accountHome, { recursive: true });
  fs.writeFileSync(accountSettings, '{"theme":"dark"}\n');
  process.env.TESSERA_DATA_DIR = dataDir;
  process.env.CLAUDE_CONFIG_DIR = accountHome;

  try {
    const overlay = createClaudeSkillOverlay('control-skill-claude');
    assertCanonicalSkillDirectory(
      path.join(overlay.pluginDir, 'skills', 'tessera-cli'),
    );
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(path.join(overlay.pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'),
      ),
      {
        name: 'tessera',
        description: 'Operate Tessera resources through the injected control CLI',
      },
    );
    assert.equal(fs.readFileSync(accountSettings, 'utf8'), '{"theme":"dark"}\n');

    overlay.dispose();
    overlay.dispose();
    assert.equal(fs.existsSync(overlay.pluginDir), false);
    assert.equal(fs.readFileSync(accountSettings, 'utf8'), '{"theme":"dark"}\n');
  } finally {
    if (previousDataDir === undefined) delete process.env.TESSERA_DATA_DIR;
    else process.env.TESSERA_DATA_DIR = previousDataDir;
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

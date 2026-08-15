import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const skillPickerSource = fs.readFileSync(
  new URL('../src/hooks/use-skill-picker.ts', import.meta.url),
  'utf8',
);
const messageInputSource = fs.readFileSync(
  new URL('../src/components/chat/message-input.tsx', import.meta.url),
  'utf8',
);
const sessionSkillsRouteSource = fs.readFileSync(
  new URL('../src/app/api/sessions/[id]/skills/route.ts', import.meta.url),
  'utf8',
);
const codexAdapterSource = fs.readFileSync(
  new URL('../src/lib/cli/providers/codex/adapter.ts', import.meta.url),
  'utf8',
);
const codexSkillSourceBlock = codexAdapterSource.slice(
  codexAdapterSource.indexOf('createSkillSource(sessionId'),
  codexAdapterSource.indexOf('// CliProvider: generateTitle'),
);

test('opening the skill picker can discover skills without starting a fresh GUI session', () => {
  assert.match(skillPickerSource, /canDiscoverBeforeSession/);
  assert.match(
    skillPickerSource,
    /canDiscoverBeforeSession[\s\S]{0,200}providerId === 'opencode'/,
    'OpenCode must use the same pre-conversation discovery path as Claude and Codex',
  );
  assert.doesNotMatch(
    skillPickerSource,
    /if \(isSessionRunning === false\) \{\s*return;\s*\}/,
    'a stopped fresh session must use provider discovery instead of treating skills as unavailable',
  );
  assert.doesNotMatch(
    skillPickerSource,
    /if \(providerId === 'opencode'\)[\s\S]{0,200}setCommands\(sessionId, \[\]\)/,
    'a stopped OpenCode session must not be cached as having no commands',
  );
  assert.doesNotMatch(messageInputSource, /prepareSessionForSkills/);
  assert.doesNotMatch(
    skillPickerSource,
    /catch\s*\{[\s\S]{0,300}setCommands\(sessionId,\s*\[\]\)/,
    'a failed or preparation-blocked discovery request must not become a cached empty catalog',
  );
  assert.match(sessionSkillsRouteSource, /listCodexSkills/);
  assert.match(sessionSkillsRouteSource, /listClaudeSkills/);
  assert.match(sessionSkillsRouteSource, /listOpenCodeCommands/);
  assert.match(sessionSkillsRouteSource, /waitForPreparationBeforeSkillDiscovery/);
});

test('Codex skill discovery uses the app-server cwd-scoped request contract', () => {
  assert.match(
    codexSkillSourceBlock,
    /params:\s*\{\s*cwds:\s*\[cwd\],\s*forceReload:\s*true,\s*\}/,
  );
  assert.doesNotMatch(codexSkillSourceBlock, /params:\s*\{\s*threadId\s*\}/);
});

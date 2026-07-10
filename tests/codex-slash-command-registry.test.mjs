import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(
  new URL('../src/lib/chat/codex-slash-command-registry.ts', import.meta.url),
  'utf8',
);
const messageInputSource = fs.readFileSync(
  new URL('../src/components/chat/message-input.tsx', import.meta.url),
  'utf8',
);
const skillPickerSource = fs.readFileSync(
  new URL('../src/hooks/use-skill-picker.ts', import.meta.url),
  'utf8',
);
const serverActionsSource = fs.readFileSync(
  new URL('../src/lib/ws/server-session-actions.ts', import.meta.url),
  'utf8',
);
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const registry = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

test('Codex 0.144.1 registry pins all 55 canonical commands without duplicates', () => {
  assert.equal(registry.CODEX_0_144_1_SLASH_COMMAND_NAMES.length, 55);
  assert.equal(new Set(registry.CODEX_0_144_1_SLASH_COMMAND_NAMES).size, 55);
  assert.ok(registry.CODEX_0_144_1_SLASH_COMMAND_NAMES.includes('fork'));
  assert.ok(registry.CODEX_0_144_1_SLASH_COMMAND_NAMES.includes('debug-m-update'));
});

test('aliases and dynamic fast resolve before skills while unknown slash text remains free', () => {
  assert.equal(registry.resolveCodexSlashCommandName('clean'), 'stop');
  assert.equal(registry.resolveCodexSlashCommandName('pet'), 'pets');
  assert.equal(registry.resolveCodexSlashCommandName('goooooooooooal'), 'goal');
  assert.equal(registry.resolveCodexSlashCommandName('fast'), 'fast');
  assert.equal(registry.resolveCodexSlashCommandName('Fork'), null, 'matching is lowercase exact');
  assert.equal(registry.classifyCodexSlashCommand('/tmp/file'), null);
  assert.equal(registry.classifyCodexSlashCommand('/foo hello'), null);
});

test('classification separates recognition from Tessera native support', () => {
  assert.deepEqual(registry.classifyCodexSlashCommand('/fork now'), {
    name: 'fork',
    canonicalName: 'fork',
    args: 'now',
    support: 'unsupported',
  });
  assert.deepEqual(registry.classifyCodexSlashCommand('/fast'), {
    name: 'fast',
    canonicalName: 'fast',
    args: '',
    support: 'native',
    nativeCommand: 'fast',
  });
  assert.equal(registry.classifyCodexSlashCommand('/goooal edit')?.nativeCommand, 'goal');
});

test('composer and server reserve official commands before skills, translation, history, or turns', () => {
  assert.match(skillPickerSource, /isReservedCodexSlashCommandName\(command\.name\)/);
  assert.ok(
    messageInputSource.indexOf('dispatchCodexSlashCommand(commandInput)') <
      messageInputSource.indexOf('skillPicker.parseForSend(trimmed)'),
  );
  assert.ok(
    messageInputSource.indexOf('classifyCodexSlashCommand(inputValue.trim())') <
      messageInputSource.indexOf('const confirmedSkill = skillPicker.confirm()'),
    'picker Enter/Tab must dispatch exact Codex commands before fuzzy skill confirmation',
  );
  assert.match(serverActionsSource, /code: 'codex_slash_command_reserved'/);
  const guardIndex = serverActionsSource.indexOf('const reservedCommand = classifyCodexSlashCommand(commandText)');
  assert.ok(guardIndex >= 0);
  assert.ok(guardIndex < serverActionsSource.indexOf('ensureSessionProcess({ sessionId, userId, sendToUser, spawnConfig })'));
  assert.ok(guardIndex < serverActionsSource.indexOf('translateOutgoingContent(content, userId'));
  assert.ok(guardIndex < serverActionsSource.indexOf('sessionHistory.recordUserMessage(sessionId, resolvedDisplayContent'));
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(
  new URL('../src/lib/terminal/terminal-surface-registry.ts', import.meta.url),
  'utf8',
);
const inputBarSource = fs.readFileSync(
  new URL('../src/components/terminal/terminal-input-bar.tsx', import.meta.url),
  'utf8',
);
const panelSource = fs.readFileSync(
  new URL('../src/components/terminal/terminal-panel.tsx', import.meta.url),
  'utf8',
);

test('only explicit user input origins pin a PTY preview', () => {
  const sendInput = source.match(/sendInput\(data: string\): boolean \{[\s\S]*?\n  \}/)?.[0] ?? '';
  const sendUserInput = source.match(/sendUserInput\(data: string\): boolean \{[\s\S]*?\n  \}/)?.[0] ?? '';
  const onData = source.match(/terminal\.onData\(\(data\) => \{[\s\S]*?\n      \}\);/)?.[0] ?? '';

  assert.doesNotMatch(sendInput, /notifyTerminalInput|onInput/);
  assert.match(sendUserInput, /notifyTerminalInput/);
  assert.match(inputBarSource, /onSend\(data\)/);
  assert.match(panelSource, /surface\.sendUserInput\(data\)/);
  assert.doesNotMatch(inputBarSource, /terminalId|sendUserInputToTerminal/);
  assert.match(onData, /if \(this\.terminalInputOriginArmed\)/);
  assert.match(source, /event\.type === 'keydown'.*!isModifierOnlyKey\(event\.key\)/s);
  assert.match(source, /clipboardData\?\.getData\('text\/plain'\)[\s\S]*armTerminalInputOrigin/);
  assert.match(source, /compositionend[\s\S]*event\.data[\s\S]*notifyTerminalInput/);
});

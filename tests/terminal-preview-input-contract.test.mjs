import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(
  new URL('../src/lib/terminal/terminal-surface-registry.ts', import.meta.url),
  'utf8',
);

test('only keyboard and paste origins pin a PTY preview', () => {
  const sendInput = source.match(/sendInput\(data: string\): boolean \{[\s\S]*?\n  \}/)?.[0] ?? '';
  const onData = source.match(/terminal\.onData\(\(data\) => \{[\s\S]*?\n      \}\);/)?.[0] ?? '';

  assert.doesNotMatch(sendInput, /notifyTerminalInput|onInput/);
  assert.match(onData, /if \(this\.terminalInputOriginArmed\)/);
  assert.match(source, /event\.type === 'keydown'.*!isModifierOnlyKey\(event\.key\)/s);
  assert.match(source, /clipboardData\?\.getData\('text\/plain'\)[\s\S]*armTerminalInputOrigin/);
  assert.match(source, /compositionend[\s\S]*event\.data[\s\S]*notifyTerminalInput/);
});

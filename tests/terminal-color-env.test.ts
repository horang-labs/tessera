import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTerminalColorEnv } from '@/lib/terminal/terminal-color-env';

test('terminal color env removes inherited opt-outs and advertises truecolor', () => {
  const source: NodeJS.ProcessEnv = {
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CLICOLOR: '0',
    TERM: 'dumb',
  };

  const result = normalizeTerminalColorEnv(source);

  assert.equal(result.NO_COLOR, undefined);
  assert.equal(result.FORCE_COLOR, undefined);
  assert.equal(result.CLICOLOR, undefined);
  assert.equal(result.TERM, 'xterm-256color');
  assert.equal(result.COLORTERM, 'truecolor');
  assert.equal(result.TERM_PROGRAM, 'Tessera');
  assert.equal(source.NO_COLOR, '1', 'normalization must not mutate its input');
});

test('terminal color env preserves positive color preferences', () => {
  const result = normalizeTerminalColorEnv({
    FORCE_COLOR: '3',
    CLICOLOR: '1',
  });

  assert.equal(result.FORCE_COLOR, '3');
  assert.equal(result.CLICOLOR, '1');
});

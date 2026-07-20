import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalHeadlessModel } from '../src/lib/terminal/terminal-headless-model';

test('disposing during a pending xterm write releases the snapshot boundary', async () => {
  const model = new TerminalHeadlessModel(80, 24);
  model.write('output before dispose\n'.repeat(50_000));
  const snapshot = model.snapshot();

  await Promise.resolve();
  model.dispose();

  await assert.rejects(
    Promise.race([
      snapshot,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('snapshot remained pending after dispose')), 100);
      }),
    ]),
    /Terminal model is disposed/,
  );
});

test('snapshot preserves the SGR mouse encoding mode a TUI enabled', async () => {
  const model = new TerminalHeadlessModel(80, 24);
  // Claude Code enables mouse tracking + SGR extended encoding on launch.
  model.write('\x1b[?1000h\x1b[?1006h');
  const { data } = await model.snapshot();

  assert.match(data, /\[\?1000h/, 'mouse tracking mode must be serialized');
  assert.match(data, /\[\?1006h/, 'SGR mouse encoding mode must be serialized');
  model.dispose();
});

test('snapshot drops encoding modes the TUI disabled or reset', async () => {
  const disabled = new TerminalHeadlessModel(80, 24);
  disabled.write('\x1b[?1000h\x1b[?1006h\x1b[?1006l');
  assert.doesNotMatch((await disabled.snapshot()).data, /\[\?1006h/);
  disabled.dispose();

  const reset = new TerminalHeadlessModel(80, 24);
  reset.write('\x1b[?1006h\x1bc');
  assert.doesNotMatch((await reset.snapshot()).data, /\[\?1006h/);
  reset.dispose();

  const softReset = new TerminalHeadlessModel(80, 24);
  softReset.write('\x1b[?1006h\x1b[!p');
  assert.doesNotMatch((await softReset.snapshot()).data, /\[\?1006h/);
  softReset.dispose();
});

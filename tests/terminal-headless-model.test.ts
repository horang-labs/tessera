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

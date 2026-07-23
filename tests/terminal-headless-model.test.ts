import assert from 'node:assert/strict';
import test from 'node:test';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { TerminalHeadlessModel } from '../src/lib/terminal/terminal-headless-model';
import { buildTerminalSnapshotReplay } from '../src/lib/terminal/terminal-snapshot-replay';
import { activateTesseraTerminalUnicodeProvider } from '../src/lib/terminal/terminal-unicode-provider';

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

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

test('snapshot replay restores an exact absolute cursor after a margin-filled row', async () => {
  const model = new TerminalHeadlessModel(10, 4);
  model.write('0123456789\x1b[3;5H');
  const snapshot = await model.snapshot();

  const restored = new Terminal({ cols: 10, rows: 4, allowProposedApi: true });
  await writeTerminal(restored, buildTerminalSnapshotReplay(snapshot));

  assert.equal(restored.buffer.active.cursorX, 4);
  assert.equal(restored.buffer.active.cursorY, 2);
  restored.dispose();
  model.dispose();
});

test('alternate-screen snapshot separates normal scrollback and restores its cursor', async () => {
  const model = new TerminalHeadlessModel(10, 4);
  model.write('normal-buffer\r\n\x1b[?1049halt-frame\x1b[3;5H');
  const snapshot = await model.snapshot();

  assert.equal(snapshot.alternateScreen, true);
  assert.match(snapshot.scrollbackAnsi ?? '', /normal-buffer/);
  assert.doesNotMatch(snapshot.data, /\[\?1049h/);

  const restored = new Terminal({ cols: 10, rows: 4, allowProposedApi: true });
  await writeTerminal(restored, buildTerminalSnapshotReplay(snapshot));
  assert.equal(restored.buffer.active.type, 'alternate');
  assert.equal(restored.buffer.active.cursorX, 4);
  assert.equal(restored.buffer.active.cursorY, 2);
  restored.dispose();
  model.dispose();
});

test('alternate-screen snapshot preserves OpenTUI rows after a width shrink', async () => {
  const cols = 20;
  const rows = 6;
  const initialCols = 24;
  const initialRows = 8;
  const model = new TerminalHeadlessModel(initialCols, initialRows);
  const labels = Array.from({ length: initialRows }, (_, index) => `ROW-${index}`);
  model.write([
    '\x1b[?1049h\x1b[2J',
    ...labels.map((label, index) => (
      `\x1b[${index + 1};1H\x1b[38;2;255;255;255;48;2;245;245;245m${label.padEnd(initialCols, ' ')}`
    )),
  ].join(''));
  // Finish parsing at the old PTY size before simulating a cold reopen at a
  // smaller surface. Otherwise resize could win the intentionally async write.
  await model.snapshot();
  model.resize(cols, rows);
  const snapshot = await model.snapshot();

  const restored = new Terminal({
    cols: snapshot.cols,
    rows: snapshot.rows,
    allowProposedApi: true,
  });
  await writeTerminal(restored, buildTerminalSnapshotReplay(snapshot));
  restored.resize(cols, rows);

  assert.deepEqual(
    Array.from({ length: rows }, (_, index) => (
      restored.buffer.active.getLine(index)?.translateToString().trimEnd()
    )),
    labels.slice(-rows),
  );
  restored.dispose();
  model.dispose();
});

test('alternate-screen snapshot does not discard columns hidden by a shrink', async () => {
  const model = new TerminalHeadlessModel(24, 4);
  model.write('\x1b[?1049h\x1b[1;24HX');
  await model.snapshot();

  model.resize(20, 4);
  await model.snapshot();
  model.resize(24, 4);
  const expanded = await model.snapshot();

  const restored = new Terminal({ cols: 24, rows: 4, allowProposedApi: true });
  await writeTerminal(restored, buildTerminalSnapshotReplay(expanded));
  assert.equal(restored.buffer.active.getLine(0)?.translateToString(), ' '.repeat(23) + 'X');
  restored.dispose();
  model.dispose();
});

test('snapshot carries a PTY escape sequence that ended between chunks', async () => {
  const model = new TerminalHeadlessModel(20, 4);
  model.write('\x1b[38;2;120');
  const partial = await model.snapshot();
  assert.equal(partial.pendingEscapeTailAnsi, '\x1b[38;2;120');

  model.write(';80;40mcolored');
  const complete = await model.snapshot();
  assert.equal(complete.pendingEscapeTailAnsi, undefined);
  assert.match(complete.data, /colored/);
  model.dispose();
});

test('headless and renderer Unicode provider budgets a ZWJ emoji as one wide glyph', async () => {
  const terminal = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
  terminal.loadAddon(new Unicode11Addon());
  activateTesseraTerminalUnicodeProvider(terminal);
  await writeTerminal(terminal, '👩‍💻');

  assert.equal(terminal.unicode.activeVersion, 'tessera-11-zwj');
  assert.equal(terminal.buffer.active.cursorX, 2);
  terminal.dispose();
});

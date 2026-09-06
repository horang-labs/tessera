import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { insertFilePathIntoTerminal } from '@/lib/terminal/terminal-file-path-insert';
import { getTerminalSurface, type TerminalSurface } from '@/lib/terminal/terminal-surface-registry';
import { getTerminalTheme } from '@/lib/terminal/terminal-theme';
import { wsClient } from '@/lib/ws/client';
import { escapeShellPath } from '@/lib/terminal/shell-path-escape';

function runPeekDrop(surface: TerminalSurface, paths: string[], activate: () => void) {
  const source = readFileSync(new URL('../src/components/terminal/terminal-panel.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('terminal-panel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback = '';
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleInputDrop') {
      const call = node.initializer as ts.CallExpression;
      callback = call.arguments[0].getText(ast);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback);
  const code = ts.transpileModule(`(${callback})(event)`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    directDropKindRef: { current: 'path' },
    resetDirectInputDrop() {},
    isNativeFileDrag: () => true,
    getNativeFileDropAbsolutePaths: () => paths,
    escapeShellPath,
    terminalId: 'file-drop-shared-session',
    insertFilePathIntoTerminal,
    surface: { sendUserInput: (data: string) => surface.sendUserInput(data), activate },
    event: { dataTransfer: {}, preventDefault() {}, stopPropagation() {} },
  });
}

function createAttachedSurface(key: string): TerminalSurface {
  const surface = getTerminalSurface({
    registryKey: key,
    terminalId: 'file-drop-shared-session',
    theme: getTerminalTheme(true),
    appearanceMode: 'dark',
    fontSize: 14,
  });
  Reflect.set(surface, 'attachedConnectionGeneration', 1);
  Reflect.set(surface, 'state', { ...surface.getSnapshot(), status: 'running' });
  Reflect.set(surface, 'terminal', { dispose() {} });
  return surface;
}

test('Peek file drop writes to its own surface even while the older list surface is attached', () => {
  const list = createAttachedSurface('direct-drop:list');
  const peek = createAttachedSurface('direct-drop:peek');
  const originalSend = wsClient.sendTerminalInput;
  const delivered: Array<{ surfaceId: string; data: string }> = [];
  let retained = 0;
  let activated = 0;
  peek.setInputListener(() => { retained += 1; });
  wsClient.sendTerminalInput = (_terminalId, surfaceId, data) => {
    delivered.push({ surfaceId, data });
    return true;
  };
  try {
    runPeekDrop(peek, ['C:\\external file.png', '/home/work/second.txt', 'invalid\npath'], () => { activated += 1; });
    assert.deepEqual(delivered, [
      { surfaceId: peek.surfaceId, data: "'C:\\external file.png' " },
      { surfaceId: peek.surfaceId, data: '/home/work/second.txt ' },
    ]);
    assert.equal(retained, 2, 'a file drop is user input and retains the Peek runtime');
    assert.equal(activated, 1);
    Reflect.get(peek, 'coldPark').call(peek);
    runPeekDrop(peek, ['/must-not-go-to-list'], () => { activated += 1; });
    assert.equal(delivered.length, 2, 'an unavailable Peek must never redirect the drop to another panel');
    assert.equal(activated, 1);
  } finally {
    wsClient.sendTerminalInput = originalSend;
    list.dispose({ detach: false });
    peek.dispose({ detach: false });
  }
});

test('external file drop reaches Peek after the older list surface cold-parks', () => {
  const list = createAttachedSurface('file-drop:list');
  const peek = createAttachedSurface('file-drop:peek');
  const attached = new Set([list.surfaceId, peek.surfaceId]);
  const delivered: Array<{ surfaceId: string; data: string }> = [];
  const originalSend = wsClient.sendTerminalInput;
  const originalDetach = wsClient.detachTerminal;
  wsClient.detachTerminal = (_terminalId, surfaceId) => { attached.delete(surfaceId); return true; };
  wsClient.sendTerminalInput = (_terminalId, surfaceId, data) => {
    // WebSocket send succeeds even when the server ignores a detached subscriber.
    if (attached.has(surfaceId)) delivered.push({ surfaceId, data });
    return true;
  };
  try {
    // Run the actual timeout action, without making a unit test wait 30 seconds.
    Reflect.get(list, 'coldPark').call(list);
    assert.equal(list.getSnapshot().status, 'running', 'the PTY still runs after its list surface detaches');
    assert.equal(attached.has(list.surfaceId), false);
    const file = 'C:\\Users\\work\\Downloads\\external file.png';
    assert.equal(insertFilePathIntoTerminal('file-drop-shared-session', file), true);
    assert.deepEqual(delivered, [{ surfaceId: peek.surfaceId, data: `'${file}' ` }]);
    assert.equal(list.sendUserInput('must not disappear into a detached subscriber'), false);
    Reflect.get(peek, 'coldPark').call(peek);
    assert.equal(insertFilePathIntoTerminal('file-drop-shared-session', file), false);
    assert.equal(delivered.length, 1, 'no attached target must not report successful insertion');
  } finally {
    wsClient.sendTerminalInput = originalSend;
    wsClient.detachTerminal = originalDetach;
    list.dispose({ detach: false });
    peek.dispose({ detach: false });
  }
});

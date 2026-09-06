import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const ts = createRequire(import.meta.url)('typescript');
const source = fs.readFileSync(new URL('../src/components/panel/panel-wrapper.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('panel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = [];
let capture;
function visit(node) {
  if (ts.isVariableDeclaration(node)
    && ['clearDropIndicators', 'handleDropCapture', 'handleDrop'].includes(node.name.getText(ast))) {
    callbacks.push(`const ${node.name.getText(ast)} = ${node.initializer.arguments[0].getText(ast)};`);
  }
  if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'onDropCapture') {
    capture = node.initializer.expression.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(capture, 'exercise the capture handler wired to the real wrapper');
const code = ts.transpileModule(`${callbacks.join('\n')}\nconst capture = ${capture};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

// Execute the production callbacks in browser event order. Only external
// stores/PTY I/O are stubbed; this is not a packaged Electron integration test.
function fixture(kind) {
  const calls = [];
  const context = {
    dropEdgeRef: { current: kind.endsWith('image') ? 'center' : 'right' },
    capturedDropRef: { current: null },
    sessionInsertZoneRef: { current: false },
    dragCounterRef: { current: 1 },
    setDropEdge() {}, setInsertPathHint() {}, setSessionInsertZone() {},
    isNativeFilePathInsertTarget: () => kind === 'native-image',
    isTerminalPathInsertTarget: () => kind === 'workspace-image',
    isTerminalSessionRefTarget: () => false,
    resolveInsertTargetTerminalId: () => 'pty-1',
    getNativeFileDropAbsolutePaths: () => ['C:\\images\\test.png'],
    getInternalPathDropPaths: () => ['/home/work/images/test.png'],
    insertFilePathIntoTerminal: (...args) => { calls.push(['insert', ...args]); return true; },
    panelId: 'target', focusPanelControl() {},
    SESSION_DRAG_MIME: 'session', TAB_PANEL_TREE_DND_MIME: 'tree', TAB_DRAG_MIME: 'tab',
    parsePanelNodeDragData: () => null, parsePanelTitleDragData: () => null,
    wrapperRef: { current: { getBoundingClientRect: () => ({ width: 1200, height: 800 }) } },
    MIN_PANEL_WIDTH: 100, MIN_PANEL_HEIGHT: 100,
    usePanelStore: { getState: () => ({
      activeTabId: 'active',
      tabPanels: { active: { panels: { target: { sessionId: 'old' } } }, source: { panels: {} } },
      setActivePanelId() {},
      graftTabIntoActiveTab: (...args) => { calls.push(['graft', ...args]); return 'new'; },
    }) },
    useTabStore: { getState: () => ({ closeTab() {}, pinTab() {} }) },
    captureTelemetryEvent() {}, projectViewWorkspaceState: { resolveSession: () => null },
    event: { preventDefault() {}, dataTransfer: {
      types: kind === 'native-image' ? ['Files'] : ['tab', 'tree'],
      getData: (key) => key === 'tree' && kind !== 'native-image' ? 'source' : '',
    } },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return {
    calls, context,
    dispatch(childConsumes = false) {
      vm.runInContext(`capture(event);${childConsumes ? '' : 'handleDrop(event);'}`, context);
    },
  };
}

test('Explorer image drop reaches the PTY after wrapper capture', () => {
  const run = fixture('native-image');
  run.dispatch();
  assert.deepEqual(run.calls, [['insert', 'pty-1', 'C:\\images\\test.png']]);
  assert.equal(run.context.dropEdgeRef.current, null);
});

test('tab edge drop grafts the source tab after wrapper capture', () => {
  const run = fixture('tab-split');
  run.dispatch();
  assert.deepEqual(run.calls, [['graft', 'source', 'target', 'right']]);
  assert.equal(run.context.dropEdgeRef.current, null);
});

test('workspace explorer image drop inserts its path after wrapper capture', () => {
  const run = fixture('workspace-image');
  run.dispatch();
  assert.deepEqual(run.calls, [['insert', 'pty-1', '/home/work/images/test.png']]);
});

test('a child consuming the drop still clears the parent indicators and refs', () => {
  const run = fixture('native-image');
  const visuals = [];
  run.context.setDropEdge = (value) => visuals.push(value);
  run.context.sessionInsertZoneRef.current = true;
  run.dispatch(true);
  assert.deepEqual(run.calls, []);
  assert.deepEqual(visuals, [null]);
  assert.equal(run.context.dropEdgeRef.current, null);
  assert.equal(run.context.sessionInsertZoneRef.current, false);
  assert.equal(run.context.dragCounterRef.current, 0);
});

test('the next drop replaces a snapshot left by a child consuming the prior drop', () => {
  const run = fixture('tab-split');
  run.dispatch(true);
  run.context.dropEdgeRef.current = 'left';
  run.dispatch();
  assert.deepEqual(run.calls, [['graft', 'source', 'target', 'left']]);
  assert.equal(run.context.capturedDropRef.current, null);
});

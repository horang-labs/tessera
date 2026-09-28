import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as drag from '@/lib/dnd/panel-session-drag';
import { toAbsoluteWorkspacePath } from '@/lib/workspace-tabs/file-path-actions';
import { insertWorkspaceFileReferencesAtCursor } from '@/lib/chat/workspace-file-reference';
import { SESSION_DRAG_MIME } from '@/types/panel';

class Transfer {
  effectAllowed = 'uninitialized';
  data = new Map<string, string>();
  get types() { return [...this.data.keys()]; }
  setData(type: string, value: string) { this.data.set(type, value); }
  getData(type: string) { return this.data.get(type) ?? ''; }
}

const gitSource = readFileSync(new URL('../src/components/git/git-panel-sections.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('git.tsx', gitSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const starts: string[] = [];
function visit(node: ts.Node) {
  if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'onDragStart') {
    const expression = (node.initializer as ts.JsxExpression).expression;
    if (expression) starts.push(expression.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);

function start(index: number, transfer: Transfer, owner: 'session' | 'worktree' | 'none', base: string, path: string, agentBase = base) {
  const code = ts.transpileModule(`(${starts[index]})(event)`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, {
    ...drag, toAbsoluteWorkspacePath,
    event: { dataTransfer: transfer, stopPropagation() {}, preventDefault() { assert.fail('Valid path must be draggable'); } },
    sessionId: owner === 'session' ? 'session-1' : null,
    workspaceTarget: owner === 'none' ? null : { kind: owner, id: `${owner}-1` },
    data: { worktreePath: base, agentWorktreePath: agentBase },
    row: { path }, file: { path },
    absolutePath: toAbsoluteWorkspacePath(base, path), canOpenReadOnly: true,
    agentPath: toAbsoluteWorkspacePath(agentBase, path),
    setSelectedPath() {},
  });
}

for (const owner of ['session', 'worktree', 'none'] as const) {
  for (const [kind, index] of [['directory', 0], ['diff', 1], ['file', 2]] as const) {
    test(`Git ${kind} drag imports its absolute path with ${owner} owner`, () => {
      const transfer = new Transfer();
      const base = '/home/work/repo with spaces';
      const relative = kind === 'directory' ? '.agents/skills' : '.agents/skills/SKILL.md';
      try {
        start(index, transfer, owner, base, relative);
        assert.deepEqual(drag.getInternalPathDropPaths(transfer), [`${base}/${relative}`]);
        assert.equal(transfer.effectAllowed, 'copyMove');
        assert.equal(Boolean(transfer.getData(SESSION_DRAG_MIME)), kind !== 'directory' && owner !== 'none');
        // Exercise the Chromium empty-transfer fallback used by every prompt surface.
        assert.deepEqual(Array.from(drag.getInternalPathDropPaths(new Transfer())), [`${base}/${relative}`]);
      } finally {
        drag.clearPathInsertDragData();
      }
      assert.equal(drag.hasPathInsertDragData(new Transfer()), false);
    });
  }
}

test('Git paths retain Windows and WSL UNC syntax', () => {
  for (const base of ['C:\\repo with spaces', '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\repo']) {
    const transfer = new Transfer();
    try {
      start(1, transfer, 'worktree', base, 'docs/readme.md');
      assert.deepEqual(drag.getInternalPathDropPaths(transfer), [`${base}\\docs\\readme.md`]);
    } finally { drag.clearPathInsertDragData(); }
  }
});

test('Windows backend uses Linux agent paths for Git prompt drops while preserving host file paths', () => {
  for (const index of [0, 1, 2]) {
    const transfer = new Transfer();
    try {
      start(index, transfer, 'worktree', '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\repo', 'docs/readme.md', '/home/work/repo');
      assert.deepEqual(drag.getInternalPathDropPaths(transfer), ['/home/work/repo/docs/readme.md']);
      if (index !== 0) assert.equal(drag.parseWorkspaceFileDragData(transfer)?.absolutePath, '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\repo\\docs\\readme.md');
    } finally { drag.clearPathInsertDragData(); }
  }
});

test('GUI drop consumes all internal paths even when Chromium empties the payload', () => {
  const source = readFileSync(new URL('../src/components/chat/message-input.tsx', import.meta.url), 'utf8');
  const inputAst = ts.createSourceFile('input.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback = '';
  function find(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(inputAst) === 'handleWrapperDrop') {
      callback = (node.initializer as ts.CallExpression).arguments[0].getText(inputAst);
    }
    ts.forEachChild(node, find);
  }
  find(inputAst);
  assert.ok(callback);
  const paths = ['/home/work/repo/a.md', '/home/work/repo/docs'];
  drag.setPathInsertDragData(new Transfer(), paths);
  let inserted: string[] = [];
  try {
    vm.runInNewContext(ts.transpileModule(`(${callback})(e)`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
      ...drag,
      e: { dataTransfer: new Transfer(), preventDefault() {}, stopPropagation() {} },
      isWorkspaceFileDrag: (e: { dataTransfer: Transfer }) => drag.hasWorkspaceFileDragData(e.dataTransfer) || drag.hasPathInsertDragData(e.dataTransfer),
      setFileDragDepth() {},
      insertWorkspaceFileReferences: (value: string[]) => { inserted = value; },
      handleSessionRefDrop() { assert.fail('Paths must not become session references'); },
      handleFileDrop() { assert.fail('Paths must not become file uploads'); },
    });
    assert.deepEqual(inserted, paths);
    assert.deepEqual(insertWorkspaceFileReferencesAtCursor('before after', 7, inserted), {
      nextValue: 'before @/home/work/repo/a.md @/home/work/repo/docs after',
      nextCursorPos: 51,
    });
  } finally { drag.clearPathInsertDragData(); }
});

function runCallback(relativePath: string, name: string, context: Record<string, unknown>, eventName = 'event') {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const ast = ts.createSourceFile('surface.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback = '';
  function find(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) {
      callback = (node.initializer as ts.CallExpression).arguments[0].getText(ast);
    }
    ts.forEachChild(node, find);
  }
  find(ast);
  assert.ok(callback, `Missing ${name}`);
  const code = ts.transpileModule(`(${callback})(${eventName})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, context);
}

for (const [kind, index] of [['folder', 0], ['file', 1]] as const) {
  test(`Git ${kind} path reaches the mounted PTY and both Chat View drop handlers`, async () => {
    const { escapeShellPath } = await import('@/lib/terminal/shell-path-escape');
    const transfer = new Transfer();
    start(index, transfer, 'worktree', '/home/work/repo with spaces', 'docs');
    const path = '/home/work/repo with spaces/docs';
    const delivered: string[] = [];
    let activated = 0;
    const context = {
      ...drag,
      event: { dataTransfer: transfer, preventDefault() {}, stopPropagation() {} },
      isNativeFileDrag: () => false,
      directDropKindRef: { current: 'path' },
      resetDirectInputDrop() {},
      escapeShellPath,
      surface: { sendUserInput(data: string) { delivered.push(data); return true; }, activate() { activated += 1; } },
      terminalId: 'session-with-an-older-list-surface',
      insertFilePathIntoTerminal() { assert.fail('Mounted Peek must not redirect to an older surface'); },
    };
    try {
      runCallback('../src/components/terminal/terminal-panel.tsx', 'handleInputDrop', context);
      assert.deepEqual(delivered, ["'/home/work/repo with spaces/docs' "]);
      assert.equal(activated, 1);
      let inserted: string[] = [];
      runCallback('../src/components/chat/terminal-chat-composer.tsx', 'handleDrop', {
        ...context, acceptsPathDrop: () => true, setDragDepth() {}, isBlocked: false, isSubmitting: false,
        insertPaths(paths: string[]) { inserted = paths; },
      });
      assert.deepEqual(Array.from(inserted), [path]);
      inserted = [];
      runCallback('../src/components/chat/chat-area.tsx', 'handleTerminalChatOverlayDrop', {
        ...context, acceptsTerminalChatPathDrop: () => true,
        terminalChatComposerRef: { current: { insertPaths(paths: string[]) { inserted = paths; } } },
      });
      assert.deepEqual(Array.from(inserted), [path]);
    } finally { drag.clearPathInsertDragData(); }
  });
}

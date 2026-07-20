import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const chatLayoutSource = fs.readFileSync(
  new URL('../src/components/chat/chat-layout.tsx', import.meta.url),
  'utf8',
);
const boardSource = fs.readFileSync(
  new URL('../src/components/board/kanban-board.tsx', import.meta.url),
  'utf8',
);
const leftPanelSource = fs.readFileSync(
  new URL('../src/components/chat/left-panel.tsx', import.meta.url),
  'utf8',
);
const peekSource = fs.readFileSync(
  new URL('../src/components/board/session-peek.tsx', import.meta.url),
  'utf8',
);
const chatAreaSource = fs.readFileSync(
  new URL('../src/components/chat/chat-area.tsx', import.meta.url),
  'utf8',
);
const terminalPanelSource = fs.readFileSync(
  new URL('../src/components/terminal/terminal-panel.tsx', import.meta.url),
  'utf8',
);
const navigationSource = fs.readFileSync(
  new URL('../src/hooks/use-session-navigation.ts', import.meta.url),
  'utf8',
);
const appHeaderSource = fs.readFileSync(
  new URL('../src/components/layout/app-header.tsx', import.meta.url),
  'utf8',
);

test('Peek mode gives the Kanban panel the workspace instead of mounting the tab area beside it', () => {
  assert.match(chatLayoutSource, /const isKanbanPeekLayout = isKanbanPeekMode && !sidebarCollapsed/);
  assert.match(chatLayoutSource, /fillAvailable=\{isKanbanPeekLayout\}/);
  assert.match(chatLayoutSource, /\{!isKanbanPeekLayout && \(\s*<div[^>]*>[\s\S]*<TabBar \/>[\s\S]*<TabPanelHost \/>/);
  assert.match(appHeaderSource, /data-testid="kanban-git-panel-toggle"/);
  assert.match(appHeaderSource, /toggleGitPanel/);
});

test('Board Peek keeps the board chrome focused while preserving the right workspace panel toggle', () => {
  assert.match(appHeaderSource, /const isKanbanPeekMode = viewMode === 'board' && kanbanSessionOpenMode === 'peek'/);
  assert.match(appHeaderSource, /\{!isKanbanPeekMode \? \([\s\S]*data-testid="sidebar-collapse-btn"[\s\S]*\) : null\}/);
  assert.match(appHeaderSource, /\{isKanbanPeekMode \? \([\s\S]*data-testid="kanban-git-panel-toggle"[\s\S]*\) : null\}/);
});

test('normal Kanban clicks open Peek without replacing the active tab session', () => {
  assert.match(boardSource, /onOpenSession:\s*kanbanSessionOpenMode === 'peek'/);
  assert.match(boardSource, /openSessionPeek\(session\.id\)/);
  assert.match(leftPanelSource, /<SessionPeek[\s\S]*sessionId=\{peekSessionId \?\? peekFileRef!\.sourceSessionId\}/);
});

test('Session Peek light-dismisses safely and hosts the shared GUI or PTY session surface', () => {
  assert.match(peekSource, /role="dialog"/);
  assert.match(peekSource, /aria-modal="true"/);
  assert.match(peekSource, /backdropPointerStartedRef/);
  assert.match(peekSource, /presentation="peek"/);
  assert.match(peekSource, /isTerminal \? 'PTY' : 'GUI'/);
  assert.match(peekSource, /value=\{PEEK_TAB_ID\}/);
  assert.match(peekSource, /panelId=\{PEEK_PANEL_ID\}/);
});

test('Session Peek uses a compact, accessible loading indicator instead of the full chat skeleton', () => {
  assert.match(chatAreaSource, /const PEEK_LOADING_DELAY_MS = 300/);
  assert.match(chatAreaSource, /setTimeout\([\s\S]*setPeekLoadingReadySessionId\(sessionId\)[\s\S]*PEEK_LOADING_DELAY_MS/);
  assert.match(chatAreaSource, /const shouldShowPeekLoading = isPeek && peekLoadingReadySessionId === sessionId/);
  assert.match(chatAreaSource, /messages === undefined[\s\S]*shouldShowPeekLoading \? <SessionPeekLoading \/> : null/);
  assert.match(chatAreaSource, /data-testid="kanban-session-peek-loading"/);
  assert.match(chatAreaSource, /role="status"/);
  assert.match(chatAreaSource, /t\("chat\.loadingSession"\)/);
  assert.match(chatAreaSource, /motion-reduce:animate-none/);
  assert.match(chatAreaSource, /startupOverlay=\{shouldShowPeekLoading \? <SessionPeekLoading \/> : undefined\}/);
  assert.match(terminalPanelSource, /status === 'starting' && startupOverlay/);
});

test('PTY sessions use retained Peek ownership without pinning or killing a tab runtime', () => {
  assert.match(chatAreaSource, /isPeek\s*\? 'session-peek'/);
  assert.match(chatAreaSource, /surfaceActive=\{isPeek\}/);
  assert.match(terminalPanelSource, /runtimeOwnership === 'standalone' \|\| runtimeOwnership === 'session-peek'/);
  assert.match(terminalPanelSource, /clearTimeout\(pendingSurfaceCleanupRef\.current\)/);
});

test('Peek loads history without mutating the hidden active tab session', () => {
  assert.match(chatAreaSource, /viewSession\(session, \{ activate: !isPeek \}\)/);
  assert.match(navigationSource, /const shouldActivate = options\?\.activate !== false/);
  assert.match(navigationSource, /if \(shouldActivate\) sessionStore\.setActiveSession\(session\.id\)/);
});

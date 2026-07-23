import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function read(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('right panel keeps read-only Git surfaces and removes Tools and mutation actions', () => {
  const panel = read('src/components/git/git-panel.tsx');
  const sections = read('src/components/git/git-panel-sections.tsx');
  const controller = read('src/components/git/use-git-panel-controller.ts');

  assert.doesNotMatch(panel, /AgentContextPanel|GitPanelFooterSection|gitPanel\.tabs\.tools/);
  assert.doesNotMatch(sections, /GitPanelFooterSection|computeGitFooterButtonStates/);
  assert.doesNotMatch(controller, /sendActionPrompt|handleCommit|handleFetch|handleMergePr/);
  assert.match(panel, /GitPanelSummarySection/);
  assert.match(panel, /GitPanelContentSection/);
  assert.match(panel, /WorkspaceFilePanel/);
  assert.match(panel, /MemoryPanel/);
  assert.equal(fs.existsSync(new URL('../src/components/git/agent-context-panel.tsx', import.meta.url)), false);
  assert.match(read('src/lib/telemetry/client.ts'), /allowedGitTabs = new Set\(\['git', 'files', 'memory'\]\)/);
});

test('Goal is absent from UI, transport, persistence, and Codex provider integration', () => {
  const sources = [
    'src/components/chat/header.tsx',
    'src/components/chat/message-input.tsx',
    'src/components/chat/context-status-bar.tsx',
    'src/hooks/use-skill-picker.ts',
    'src/hooks/use-websocket.ts',
    'src/lib/ws/message-types.ts',
    'src/lib/ws/client.ts',
    'src/lib/ws/server-message-routing.ts',
    'src/lib/ws/server-session-actions.ts',
    'src/lib/cli/process-manager.ts',
    'src/lib/cli/providers/provider-contract.ts',
    'src/lib/cli/providers/codex/adapter.ts',
    'src/lib/cli/providers/codex/protocol-parser.ts',
    'src/lib/db/sessions.ts',
    'src/stores/session-store.ts',
    'src/types/chat.ts',
  ].map(read).join('\n');

  assert.doesNotMatch(sources, /SessionGoal|session_goal|thread\/goal|SessionGoalControl|CODEX_GOAL/);
  assert.match(read('src/lib/cli/providers/codex/adapter.ts'), /return \['app-server'\];/);
  for (const relativePath of [
    'src/components/chat/session-goal-control.tsx',
    'src/lib/chat/codex-goal-command.ts',
    'src/lib/chat/session-goal-command-event.ts',
    'src/types/session-goal.ts',
  ]) {
    assert.equal(fs.existsSync(new URL(`../${relativePath}`, import.meta.url)), false);
  }
});

test('session PTY owns a workspace listener and lifecycle completion performs final Git reconciliation', () => {
  const terminalManager = read('src/lib/terminal/terminal-manager.ts');
  const sharedManager = read('src/lib/terminal/shared-terminal-manager.ts');
  const watcher = read('src/lib/workspace-files/workspace-file-watch-manager.ts');
  const hookReceiver = read('src/lib/cli/hook-receiver.ts');

  assert.match(terminalManager, /observeSessionRuntime/);
  assert.match(terminalManager, /disposeSessionObserver/);
  assert.match(sharedManager, /subscribeRootChanges/);
  assert.match(sharedManager, /scheduleRecompute\(root, userId\)/);
  assert.match(watcher, /rootChangeListeners/);
  assert.match(
    hookReceiver,
    /mapped\?\.status === 'completed'[\s\S]*refreshSessionDiffStateInBackground\(sessionId, entry\.userId, 'terminal lifecycle completion'\)/,
  );
});

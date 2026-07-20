import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const fetchWithTimeoutSource = fs.readFileSync(new URL('../src/lib/api/fetch-with-timeout.ts', import.meta.url), 'utf8');
const fileTabSource = fs.readFileSync(new URL('../src/components/workspace/workspace-file-tab.tsx', import.meta.url), 'utf8');
const codeViewSource = fs.readFileSync(new URL('../src/components/workspace/workspace-code-view.tsx', import.meta.url), 'utf8');
const fileRouteSource = fs.readFileSync(new URL('../src/app/api/sessions/[id]/file/route.ts', import.meta.url), 'utf8');
const gitPanelSource = fs.readFileSync(new URL('../src/lib/git/git-panel.ts', import.meta.url), 'utf8');
const filePanelSource = fs.readFileSync(new URL('../src/components/workspace/workspace-file-panel.tsx', import.meta.url), 'utf8');
const explorerTabSource = fs.readFileSync(new URL('../src/components/workspace/workspace-explorer-tab.tsx', import.meta.url), 'utf8');
const fileListHookSource = fs.readFileSync(new URL('../src/hooks/use-workspace-file-list.ts', import.meta.url), 'utf8');

test('fetchWithTimeout enforces a deadline and retries only on timeout', () => {
  assert.match(fetchWithTimeoutSource, /AbortSignal\.timeout\(timeoutMs\)/);
  assert.match(fetchWithTimeoutSource, /AbortSignal\.any\(\[signal, timeoutSignal\]\)/);
  assert.match(fetchWithTimeoutSource, /if \(signal\?\.aborted \|\| !isTimeoutError\(error\)\) throw error;/);
});

test('workspace file tab loads through fetchWithTimeout with one automatic retry', () => {
  assert.match(fileTabSource, /fetchWithTimeout\(/);
  assert.match(fileTabSource, /timeoutMs:\s*FILE_LOAD_TIMEOUT_MS,\s*retries:\s*1/);
  assert.match(fileTabSource, /FILE_LOAD_TIMEOUT_MESSAGE/);
  assert.doesNotMatch(fileTabSource, /await fetch\(/);
});

test('silent refreshes do not supersede an in-flight load and keep shown content on failure', () => {
  assert.match(fileTabSource, /if \(options\?\.silent && activeLoadsRef\.current > 0\) return;/);
  assert.match(fileTabSource, /current\.data \? current :/);
});

test('code view keeps the close button visible while loading and offers retry on error', () => {
  assert.match(codeViewSource, /PendingStateHeader/);
  const loadingBranch = codeViewSource.match(/if \(loading\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(loadingBranch, /PendingStateHeader/);
  const errorBranch = codeViewSource.match(/if \(error\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(errorBranch, /PendingStateHeader/);
  assert.match(errorBranch, /onRetry/);
  assert.match(errorBranch, /Retry/);
});

test('file route bounds every workspace fs operation with a deadline', () => {
  assert.match(fileRouteSource, /function withFsDeadline/);
  assert.match(fileRouteSource, /filesystem_timeout/);
  assert.match(fileRouteSource, /504/);
  assert.match(fileRouteSource, /withFsDeadline\(fs\.realpath\(root\)\)/);
  assert.match(fileRouteSource, /withFsDeadline\(fs\.realpath\(candidatePath\)\)/);
  assert.match(fileRouteSource, /withFsDeadline\(fs\.stat\(absolutePath\)\)/);
  assert.match(fileRouteSource, /withFsDeadline\(fs\.readFile\(absolutePath\)\)/);
  assert.match(fileRouteSource, /withFsDeadline\(fs\.open\(absolutePath, "r"\)\)/);
  assert.match(fileRouteSource, /withFsDeadline\(handle\.read\(/);
  assert.doesNotMatch(fileRouteSource, /await handle\.close\(\);/);
});

test('git panel commands are killed after a timeout and never wait on a credential prompt', () => {
  // The rejection must come from our own timer, not spawn's `timeout` option:
  // a wedged grandchild holding the stdio pipes delays 'close' past the kill.
  assert.match(gitPanelSource, /setTimeout\(\(\) => \{\s*reject\(new GitPanelError\(\s*"command_timeout"/);
  assert.match(gitPanelSource, /process\.kill\(-child\.pid, "SIGKILL"\)/);
  assert.match(gitPanelSource, /GIT_TERMINAL_PROMPT:\s*"0"/);
  assert.match(gitPanelSource, /did not respond within/);
  assert.doesNotMatch(gitPanelSource, /timeout:\s*COMMAND_TIMEOUT_MS/);
});

test('a timed-out git command surfaces as 504 instead of degrading to an optional null', () => {
  const optionalSource = gitPanelSource.match(/async function runOptionalCommand[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(optionalSource, /error instanceof GitPanelError && error\.status === 504\) throw error/);
});

test('worktree diff stats git runner opts into the kill timer', () => {
  const gitRunnerSource = fs.readFileSync(new URL('../src/lib/worktrees/git-runner.ts', import.meta.url), 'utf8');
  const diffStatsSource = fs.readFileSync(new URL('../src/lib/git/worktree-diff-stats.ts', import.meta.url), 'utf8');
  assert.match(gitRunnerSource, /timeoutMs\?/);
  assert.match(gitRunnerSource, /process\.kill\(-child\.pid, 'SIGKILL'\)/);
  assert.match(diffStatsSource, /createGitRunner\(agentEnvironment, \{ timeoutMs: 10_000 \}\)/);
});

test('file list flows use the timeout-aware fetch', () => {
  assert.match(filePanelSource, /useWorkspaceFileList/);
  assert.match(explorerTabSource, /useWorkspaceFileList/);
  assert.match(fileListHookSource, /fetchWithTimeout\(/);
  assert.match(fileListHookSource, /isTimeoutError/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const messageTypesSource = fs.readFileSync(new URL('../src/lib/ws/message-types.ts', import.meta.url), 'utf8');
const routingSource = fs.readFileSync(new URL('../src/lib/ws/server-message-routing.ts', import.meta.url), 'utf8');
const serverSessionActionsSource = fs.readFileSync(new URL('../src/lib/ws/server-session-actions.ts', import.meta.url), 'utf8');
const wsServerSource = fs.readFileSync(new URL('../src/lib/ws/server.ts', import.meta.url), 'utf8');
const terminalManagerSource = fs.readFileSync(new URL('../src/lib/terminal/terminal-manager.ts', import.meta.url), 'utf8');
const terminalResolverSource = fs.readFileSync(new URL('../src/lib/terminal/terminal-resolver.ts', import.meta.url), 'utf8');
const terminalLaunchIntentSource = fs.readFileSync(new URL('../src/lib/terminal/terminal-launch-intent.ts', import.meta.url), 'utf8');
const terminalHandoffLockSource = fs.readFileSync(new URL('../src/lib/terminal/terminal-handoff-lock.ts', import.meta.url), 'utf8');
const processManagerSource = fs.readFileSync(new URL('../src/lib/cli/process-manager.ts', import.meta.url), 'utf8');
const clientTerminalCwdSource = fs.readFileSync(new URL('../src/lib/terminal/client-terminal-cwd.ts', import.meta.url), 'utf8');
const hostPathSource = fs.readFileSync(new URL('../src/lib/filesystem/host-path.ts', import.meta.url), 'utf8');
const pathExistsSource = fs.readFileSync(new URL('../src/lib/filesystem/path-exists.ts', import.meta.url), 'utf8');
const sessionWorkspaceRootSource = fs.readFileSync(new URL('../src/lib/session/session-workspace-root.ts', import.meta.url), 'utf8');
const sessionFileRouteSource = fs.readFileSync(new URL('../src/app/api/sessions/[id]/file/route.ts', import.meta.url), 'utf8');
const sessionFilesRouteSource = fs.readFileSync(new URL('../src/app/api/sessions/[id]/files/route.ts', import.meta.url), 'utf8');
const projectsRouteSource = fs.readFileSync(new URL('../src/app/api/projects/route.ts', import.meta.url), 'utf8');
const archiveServiceSource = fs.readFileSync(new URL('../src/lib/archive/archive-service.ts', import.meta.url), 'utf8');
const sessionArchiveSource = fs.readFileSync(new URL('../src/lib/session/session-archive.ts', import.meta.url), 'utf8');
const sessionOrchestratorSource = fs.readFileSync(new URL('../src/lib/session/session-orchestrator.ts', import.meta.url), 'utf8');
const sessionArchiveRouteSource = fs.readFileSync(new URL('../src/app/api/sessions/[id]/archive/route.ts', import.meta.url), 'utf8');
const taskArchiveRouteSource = fs.readFileSync(new URL('../src/app/api/archive/tasks/[id]/route.ts', import.meta.url), 'utf8');
const worktreeDiffStatsSource = fs.readFileSync(new URL('../src/lib/git/worktree-diff-stats.ts', import.meta.url), 'utf8');
const gitPanelSource = fs.readFileSync(new URL('../src/lib/git/git-panel.ts', import.meta.url), 'utf8');
const prStatusProviderSource = fs.readFileSync(new URL('../src/lib/github/pr-status-provider.ts', import.meta.url), 'utf8');
const managedWorktreesSource = fs.readFileSync(new URL('../src/lib/worktrees/managed.ts', import.meta.url), 'utf8');
const terminalPanelSource = fs.readFileSync(new URL('../src/components/terminal/terminal-panel.tsx', import.meta.url), 'utf8');
const emptyPanelStateSource = fs.readFileSync(new URL('../src/components/panel/empty-panel-state.tsx', import.meta.url), 'utf8');
const wsClientSource = fs.readFileSync(new URL('../src/lib/ws/client.ts', import.meta.url), 'utf8');
const panelWrapperSource = fs.readFileSync(new URL('../src/components/panel/panel-wrapper.tsx', import.meta.url), 'utf8');
const panelStoreSource = fs.readFileSync(new URL('../src/stores/panel-store.ts', import.meta.url), 'utf8');
const tabItemSource = fs.readFileSync(new URL('../src/components/tab/tab-item.tsx', import.meta.url), 'utf8');
const tabBarSource = fs.readFileSync(new URL('../src/components/tab/tab-bar.tsx', import.meta.url), 'utf8');
const panelTypesSource = fs.readFileSync(new URL('../src/types/panel.ts', import.meta.url), 'utf8');
const prepareElectronRuntimeSource = fs.readFileSync(new URL('../scripts/prepare-electron-runtime.mjs', import.meta.url), 'utf8');

test('terminal feature declares browser UI and server PTY dependencies', () => {
  assert.ok(packageJson.dependencies['@xterm/xterm']);
  assert.ok(packageJson.dependencies['@xterm/addon-fit']);
  assert.ok(packageJson.dependencies['node-pty']);
});

test('terminal websocket protocol covers process lifecycle', () => {
  for (const type of [
    'terminal_create',
    'terminal_input',
    'terminal_resize',
    'terminal_close',
    'terminal_started',
    'terminal_prefill_written',
    'terminal_prefill_cancelled',
    'terminal_output',
    'terminal_exit',
    'terminal_error',
  ]) {
    assert.match(messageTypesSource, new RegExp(`type: '${type}'`));
  }
});

test('terminal launch success is acknowledged only after the slash prefill is written', () => {
  assert.match(terminalManagerSource, /type: 'terminal_prefill_written'/);
  assert.match(terminalManagerSource, /type: 'terminal_prefill_cancelled'/);
  assert.match(terminalPanelSource, /message\.type === 'terminal_prefill_written'/);
  assert.match(terminalPanelSource, /message\.type === 'terminal_prefill_cancelled'/);
  assert.match(terminalPanelSource, /dispatchTerminalLaunchResult/);
});

test('terminal messages route through the server terminal manager', () => {
  assert.match(routingSource, /const terminalManager = bindTerminalSender\(sendToUser\)/);
  assert.match(routingSource, /await terminalManager\.create/);
  assert.match(routingSource, /case 'terminal_create':/);
  assert.match(routingSource, /case 'terminal_input':/);
  assert.match(routingSource, /case 'terminal_resize':/);
  assert.match(routingSource, /case 'terminal_close':/);
});

test('terminal slash fallback transports intent rather than executable data', () => {
  assert.match(messageTypesSource, /launchIntent\?: TerminalLaunchIntent/);
  assert.doesNotMatch(messageTypesSource, /terminal_create[^\n]+launchCommand/);
  assert.doesNotMatch(messageTypesSource, /terminal_create[^\n]+threadId/);
  assert.match(wsClientSource, /launchIntent\?: TerminalLaunchIntent/);
  assert.match(routingSource, /resolveTerminalLaunchIntent/);
  assert.match(routingSource, /launchSpec/);
});

test('Codex terminal launch is classified and resolved on the server', () => {
  assert.match(terminalLaunchIntentSource, /classifyCodexSlashCommand\(commandInput\)/);
  assert.match(terminalLaunchIntentSource, /resolveProviderCliCommand\('codex', 'codex'/);
  assert.match(terminalLaunchIntentSource, /extractThreadId\(session\.provider_state\)/);
  assert.match(terminalLaunchIntentSource, /CODEX_THREAD_ID_RE\.test\(threadId\)/);
  assert.match(terminalLaunchIntentSource, /shellPrefillArgv: \{ program, args: \['fork', threadId\] \}/);
  assert.match(terminalLaunchIntentSource, /args: \['resume', threadId\]/);
  assert.match(terminalLaunchIntentSource, /isCodexSlashCommandAvailable/);
});

test('handoff ownership is locked and released on every terminal lifecycle exit', () => {
  assert.match(terminalHandoffLockSource, /acquireTerminalHandoffLock/);
  assert.match(terminalHandoffLockSource, /isSessionHandedOffToTerminal/);
  assert.match(terminalManagerSource, /releaseTerminalHandoffByTerminal\(options\.userId, options\.terminalId\)/);
  assert.match(terminalManagerSource, /releaseTerminalHandoffByTerminal\(userId, terminalId\)/);
  assert.match(serverSessionActionsSource, /code: 'session_handed_off_to_terminal'/);
  assert.match(routingSource, /eventType: 'session_stopped'/);
  assert.match(routingSource, /beginTesseraSessionOperation/);
  assert.match(routingSource, /endTesseraSessionOperation/);
  assert.match(processManagerSource, /Discarded late CLI spawn after terminal handoff/);
  assert.match(terminalHandoffLockSource, /sessionForTerminal && sessionForTerminal !== lock\.sessionId/);
  assert.match(terminalHandoffLockSource, /activeTesseraOperations\.get\(lock\.sessionId\)/);
  assert.match(terminalHandoffLockSource, /Symbol\.for\('tessera\.terminalHandoffState'\)/);
  assert.match(terminalHandoffLockSource, /globalThis/);
});

test('resume, delete, archive, restore, and worktree cleanup hold atomic handoff exclusion', () => {
  assert.match(sessionOrchestratorSource, /withTesseraSessionOperation\(sessionId/);
  assert.match(sessionOrchestratorSource, /resumeSessionWithLifecycle/);
  assert.match(sessionOrchestratorSource, /removeManagedWorktree/);
  assert.match(sessionArchiveSource, /withTesseraSessionOperation\(sessionId/);
  assert.match(archiveServiceSource, /withTesseraSessionOperation\(sessionId/);
  assert.match(archiveServiceSource, /withTesseraSessionOperations\(task\.sessions\.map/);
  assert.match(archiveServiceSource, /beginTesseraSessionOperations\(item\.sessions\.map/);
  assert.match(archiveServiceSource, /endTesseraSessionOperations\(acquired\)/);
  assert.match(sessionArchiveRouteSource, /isTerminalHandoffConflictError/);
  assert.match(sessionArchiveRouteSource, /\? 409/);
  assert.match(taskArchiveRouteSource, /isTerminalHandoffConflictError/);
  assert.match(taskArchiveRouteSource, /\? 409/);
});

test('terminal prefill strips control characters and never appends Enter', () => {
  assert.match(terminalManagerSource, /replace\(\/\[\\x00-\\x1f\\x7f-\\x9f\]\+\/g, ' '\)/);
  assert.match(terminalManagerSource, /terminalProcess\.write\(sanitized\)/);
  assert.doesNotMatch(terminalManagerSource, /terminalProcess\.write\(`\$\{sanitized\}\\[rn]`\)/);
});

test('panels can own terminal process identity separately from agent sessions', () => {
  assert.match(panelTypesSource, /terminalId\?: string \| null/);
});

test('terminal processes are cleaned up after the final websocket disconnects', () => {
  assert.match(wsServerSource, /terminalManager\.closeAllForUser\(userId\)/);
});

test('terminal cwd is server validated before spawning a PTY', () => {
  assert.match(terminalManagerSource, /resolveAllowedTerminalCwd/);
  assert.match(terminalResolverSource, /getVisibleProjects/);
  assert.match(terminalResolverSource, /getSession/);
  assert.match(terminalResolverSource, /Terminal cwd must be inside a registered project or active worktree/);
  assert.match(terminalLaunchIntentSource, /readSessionLaunchCwd/);
  assert.match(routingSource, /cwd: launchSpec\?\.cwd \?\? message\.cwd/);
  assert.match(routingSource, /shellKind: launchSpec \? undefined : message\.shellKind/);
});

test('raw terminals may fall back, but command launches fail closed on a deleted session cwd', () => {
  assert.match(terminalResolverSource, /getProject/);
  assert.match(terminalResolverSource, /resolveFirstExistingAllowedRoot/);
  assert.match(terminalResolverSource, /if \(!allowFallback\) \{\n\s+return \{ ok: false, message: 'The session workspace no longer exists/);
  assert.match(terminalResolverSource, /const fallbackCwd = resolveFirstExistingAllowedRoot\(allowedRoots\)/);
  assert.match(terminalManagerSource, /allowFallback: !options\.launchSpec/);
});

test('terminal cwd validation resolves WSL POSIX paths for Windows Electron', () => {
  assert.match(terminalResolverSource, /getRuntimePlatform\(\) !== 'win32'/);
  assert.match(terminalResolverSource, /getWindowsHostedWslReferenceRoots/);
  assert.match(terminalResolverSource, /toWindowsHostedWslPath/);
  assert.match(terminalResolverSource, /execFileSync\(\n\s+'wsl\.exe'/);
  assert.match(terminalResolverSource, /\? path\.posix\n\s+: path/);
  assert.match(terminalResolverSource, /pathModule\.relative/);
});

test('server filesystem reads resolve WSL POSIX paths before calling node fs', () => {
  assert.match(hostPathSource, /export async function resolvePathForHostFilesystem/);
  assert.match(hostPathSource, /getRuntimePlatform\(\) === 'win32' && trimmed\.startsWith\('\/'\)/);
  assert.match(hostPathSource, /resolveBrowsePath\(trimmed, 'wsl'\)/);
  assert.match(pathExistsSource, /resolvePathForHostFilesystem\(candidate\)/);
  assert.match(sessionWorkspaceRootSource, /resolveSessionWorkspaceFilesystemRoot/);
  assert.match(sessionFileRouteSource, /resolveSessionWorkspaceFilesystemRoot\(id\)/);
  assert.match(sessionFileRouteSource, /getFilesystemPathModule\(root\)/);
  assert.match(sessionFilesRouteSource, /resolveSessionWorkspaceFilesystemRoot\(id\)/);
  assert.match(sessionFilesRouteSource, /workspaceFileWatchManager\.getIndexedSnapshotForRoot\(root\)/);
  assert.match(sessionFilesRouteSource, /walkWorkspaceFiles\(root\)/);
  assert.match(projectsRouteSource, /resolveBrowsePath\(\n\s+folderPath,\n\s+settings\.agentEnvironment,/);
  assert.match(archiveServiceSource, /pathExists\(workDir\)/);
  assert.match(archiveServiceSource, /resolvePathForHostFilesystem\(item\.workDir\)/);
  assert.match(worktreeDiffStatsSource, /await resolveFilesystemPath\(workDir\)/);
  assert.match(worktreeDiffStatsSource, /getRuntimePlatform\(\) === 'win32' && workDir\.trim\(\)\.startsWith\('\/'\)/);
  assert.match(gitPanelSource, /await resolveNodeFilesystemPath\(\n\s+repoRoot,\n\s+referenceFilesystemPath,/);
  assert.match(gitPanelSource, /resolvePathForHostFilesystem\(gitPath\)/);
  assert.match(gitPanelSource, /getRuntimePlatform\(\) === "win32" && workDir\.trim\(\)\.startsWith\("\/"\)/);
  assert.match(prStatusProviderSource, /AgentEnvironment = inferGitHubToolEnvironment\(workDir\)/);
  assert.match(prStatusProviderSource, /getRuntimePlatform\(\) === 'win32' && workDir\.trim\(\)\.startsWith\('\/'\)/);
  assert.match(managedWorktreesSource, /resolvePathForHostFilesystem\(worktreePathModule\.dirname\(worktreePath\)\)/);
});

test('terminal ownership keys include user id and terminal id', () => {
  assert.match(terminalManagerSource, /getKey\(userId: string, terminalId: string\)/);
  assert.match(terminalManagerSource, /`\$\{userId\}:\$\{terminalId\}`/);
  assert.match(terminalManagerSource, /const key = this\.getKey\(userId, terminalId\)/);
  assert.match(terminalManagerSource, /this\.terminals\.delete\(key\)/);
  assert.match(terminalManagerSource, /this\.terminals\.get\(key\) !== runtime/);
});

test('pending terminal startup can be cancelled and duplicate IDs are single-flight', () => {
  assert.match(terminalManagerSource, /pendingCreates = new Map/);
  assert.match(terminalManagerSource, /launchReservations = new Map/);
  assert.match(terminalManagerSource, /reserveTerminalLaunch/);
  assert.match(routingSource, /isTerminalLaunchReserved/);
  assert.match(routingSource, /releaseTerminalLaunchReservation/);
  assert.match(terminalManagerSource, /pendingCreate\.cancelled = true/);
  assert.match(terminalManagerSource, /Terminal startup was cancelled/);
  assert.match(terminalManagerSource, /hasOrPendingTerminal/);
});

test('launched TUIs exit instead of falling through to a command shell', () => {
  assert.match(terminalResolverSource, /const inner = `exec \$\{buildPosixCommand/);
  assert.match(terminalResolverSource, /`exec \$\{buildPosixCommand\(launch\.program, launch\.args\)\}`/);
  assert.match(terminalResolverSource, /args: launch \? \['\/c'/);
  assert.doesNotMatch(terminalResolverSource, /NoExit/);
  assert.match(terminalManagerSource, /User input wins over a delayed automatic prefill/);
});

test('terminal launch intent is runtime validated before classification', () => {
  assert.match(terminalLaunchIntentSource, /options\.intent\.kind !== 'claude-slash'/);
  assert.match(terminalLaunchIntentSource, /typeof options\.intent\.commandInput !== 'string'/);
});

test('terminal client subscribes before creating the server process', () => {
  assert.ok(
    terminalPanelSource.indexOf('subscribeServerMessages') <
      terminalPanelSource.indexOf('wsClient.createTerminal'),
  );
  assert.match(terminalPanelSource, /connectionStatus !== 'connected'/);
  assert.match(terminalPanelSource, /didCreateTerminal/);
  assert.match(wsClientSource, /createTerminal\(args: \{/);
  assert.match(wsClientSource, /\}\): boolean \{/);
});

test('terminal creation is not tied to active panel focus changes', () => {
  assert.doesNotMatch(terminalPanelSource, /useSessionStore\(\(state\) => state\.activeSessionId\)/);
  assert.doesNotMatch(terminalPanelSource, /useSessionStore\.getState\(\)\.activeSessionId/);
  assert.match(terminalPanelSource, /\}, \[connectionStatus, terminalId, terminalSessionId\]\);/);
});

test('terminal panels without a bound session do not inherit stale active session cwd', () => {
  assert.match(emptyPanelStateSource, /assignTerminal\(panelId, uuidv4\(\)\)/);
  assert.match(clientTerminalCwdSource, /getSessionSelectionId\(sessionId \?\? null\)/);
  assert.doesNotMatch(clientTerminalCwdSource, /sessionId \?\? sessionState\.activeSessionId/);
});

test('terminal panels preserve the source session context used to create them', () => {
  assert.match(panelTypesSource, /terminalSessionId\?: string \| null/);
  assert.match(panelStoreSource, /assignTerminal\(newPanelId, terminalId, activePanel\.sessionId\)/);
  assert.match(panelStoreSource, /terminalSessionId: oldPanel\.terminalSessionId \?\? null/);
  assert.match(panelStoreSource, /sessionId, terminalId: null, terminalSessionId: null/);
  assert.match(terminalPanelSource, /terminalSessionId: string \| null/);
  assert.match(terminalPanelSource, /sessionId: getSessionSelectionId\(terminalSessionId\)/);
  assert.doesNotMatch(terminalPanelSource, /useSessionStore\.getState\(\)\.activeSessionId/);
});

test('terminal panels expose a panel drag handle', () => {
  assert.match(terminalPanelSource, /setPanelNodeDragData/);
  assert.match(terminalPanelSource, /data-testid="terminal-panel-drag-handle"/);
  assert.match(terminalPanelSource, /data-testid="terminal-panel-empty-drag-region"/);
  assert.match(terminalPanelSource, /draggable/);
});

test('terminal-only tabs can be dragged into another panel tree', () => {
  assert.match(tabItemSource, /Object\.values\(panels\)\.some\(\(panel\) => panel\.terminalId\)/);
  assert.match(tabItemSource, /displayTitle = 'Terminal'/);
  assert.doesNotMatch(panelWrapperSource, /droppedTabTreeId && sourceTabData && Object\.keys\(sourceTabData\.panels\)\.length > 1/);
});

test('terminal panels can be pulled into a new tab from a multi-panel layout', () => {
  assert.match(tabBarSource, /parsePanelNodeDragData/);
  assert.match(tabBarSource, /const terminalId = sourcePanel\?\.terminalId \?\? null/);
  assert.match(tabBarSource, /const terminalSessionId = sourcePanel\?\.terminalSessionId \?\? null/);
  assert.match(tabBarSource, /panelStore\.closePanel\(payload\.panelId\)/);
  assert.match(tabBarSource, /tabStore\.createTab\(null, \{ insertAfterTabId: payload\.tabId \}\)/);
  assert.match(tabBarSource, /assignTerminal\(newPanelId, terminalId, terminalSessionId\)/);
});

test('terminal remount attaches to the existing server process', () => {
  assert.match(terminalManagerSource, /const existing = this\.terminals\.get\(key\)/);
  assert.match(terminalManagerSource, /this\.sendStarted\(existing\)/);
  assert.match(terminalManagerSource, /this\.replayBufferedOutput\(existing\)/);
  assert.doesNotMatch(terminalManagerSource, /this\.close\(options\.terminalId, options\.userId\);\n\n    try/);
});

test('panel node drag preserves terminal panel identity', () => {
  assert.match(panelWrapperSource, /movePanelNode/);
  assert.match(panelStoreSource, /movePanelNode:/);
  assert.match(panelStoreSource, /terminalId: sourcePanel\.terminalId \?\? null/);
  assert.match(panelStoreSource, /terminalId: targetPanel\.terminalId \?\? null/);
  assert.match(panelStoreSource, /terminalSessionId: sourcePanel\.terminalSessionId \?\? null/);
  assert.match(panelStoreSource, /terminalSessionId: targetPanel\.terminalSessionId \?\? null/);
});

test('terminal shell selection follows the configured agent environment', () => {
  assert.match(terminalManagerSource, /getAgentEnvironment/);
  assert.match(terminalManagerSource, /agentEnvironment === 'wsl'/);
  assert.match(terminalManagerSource, /useConpty: false/);
  assert.match(terminalResolverSource, /command: 'wsl\.exe'/);
  assert.match(terminalResolverSource, /args: \['-e', 'sh', '-c', buildWslTerminalScript\(wslCwd, options\.launchSpec\)\]/);
  assert.doesNotMatch(terminalResolverSource, /'-lc'/);
  assert.match(terminalResolverSource, /getent passwd "\$\(id -un\)"/);
  assert.match(terminalResolverSource, /exec "\$shell" -i/);
  assert.match(terminalResolverSource, /resolveWindowsNativeTerminalCwd/);
  assert.match(terminalResolverSource, /isWindowsHostedWslPath/);
  assert.doesNotMatch(terminalResolverSource, /WSL terminal profiles are not supported yet/);
});

test('macOS terminal startup preserves user login PATH and executable node-pty helper', () => {
  assert.match(terminalManagerSource, /ensureNodePtySpawnHelperExecutable/);
  assert.match(terminalManagerSource, /nodeRequire\.resolve\('node-pty\/package\.json'\)/);
  assert.match(terminalManagerSource, /spawn-helper/);
  assert.match(terminalManagerSource, /fs\.chmodSync\(helperPath, stat\.mode \| 0o755\)/);
  assert.match(terminalManagerSource, /buildSpawnEnv\(env\)/);
  assert.match(terminalResolverSource, /platform === 'darwin' \? \['-l'\] : \[\]/);
});

test('electron packages node-pty native runtime assets outside the asar', () => {
  assert.ok(packageJson.build.asarUnpack.includes('**/node_modules/node-pty/prebuilds/**'));
  assert.ok(packageJson.build.asarUnpack.includes('**/node_modules/node-pty/build/Release/*.node'));
  assert.match(prepareElectronRuntimeSource, /addDirectory\('node_modules\/node-pty\/lib\/worker'/);
  assert.match(prepareElectronRuntimeSource, /addDirectory\('node_modules\/node-pty\/prebuilds'/);
  assert.match(prepareElectronRuntimeSource, /addDirectory\('node_modules\/node-pty\/build\/Release'/);
  assert.match(prepareElectronRuntimeSource, /node_modules\/node-pty\/prebuilds\//);
  assert.match(prepareElectronRuntimeSource, /\.pdb/);
});

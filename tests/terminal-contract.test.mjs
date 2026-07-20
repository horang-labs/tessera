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
const providerTerminalLaunchSource = fs.readFileSync(new URL('../src/lib/terminal/provider-launch.ts', import.meta.url), 'utf8');
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
const chatAreaSource = fs.readFileSync(new URL('../src/components/chat/chat-area.tsx', import.meta.url), 'utf8');
const terminalPanelSource = fs.readFileSync(new URL('../src/components/terminal/terminal-panel.tsx', import.meta.url), 'utf8');
const tabPanelHostSource = fs.readFileSync(new URL('../src/components/tab/tab-panel-host.tsx', import.meta.url), 'utf8');
const terminalSurfaceSource = fs.readFileSync(new URL('../src/lib/terminal/terminal-surface-registry.ts', import.meta.url), 'utf8');
const terminalScrollControllerSource = fs.readFileSync(new URL('../src/lib/terminal/terminal-scroll-controller.ts', import.meta.url), 'utf8');
const layoutSettleRunnerSource = fs.readFileSync(new URL('../src/lib/terminal/layout-settle-runner.ts', import.meta.url), 'utf8');
const scrollToBottomButtonSource = fs.readFileSync(new URL('../src/components/ui/scroll-to-bottom-button.tsx', import.meta.url), 'utf8');
const electronMainSource = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const electronPreloadSource = fs.readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');
const terminalThemeUrl = new URL('../src/lib/terminal/terminal-theme.ts', import.meta.url);
const terminalThemeSource = fs.existsSync(terminalThemeUrl)
  ? fs.readFileSync(terminalThemeUrl, 'utf8')
  : '';
const terminalCssSource = fs.readFileSync(new URL('../src/app/terminal.css', import.meta.url), 'utf8');
const emptyPanelStateSource = fs.readFileSync(new URL('../src/components/panel/empty-panel-state.tsx', import.meta.url), 'utf8');
const wsClientSource = fs.readFileSync(new URL('../src/lib/ws/client.ts', import.meta.url), 'utf8');
const panelWrapperSource = fs.readFileSync(new URL('../src/components/panel/panel-wrapper.tsx', import.meta.url), 'utf8');
const panelStoreSource = fs.readFileSync(new URL('../src/stores/panel-store.ts', import.meta.url), 'utf8');
const tabItemSource = fs.readFileSync(new URL('../src/components/tab/tab-item.tsx', import.meta.url), 'utf8');
const tabBarSource = fs.readFileSync(new URL('../src/components/tab/tab-bar.tsx', import.meta.url), 'utf8');
const panelTypesSource = fs.readFileSync(new URL('../src/types/panel.ts', import.meta.url), 'utf8');
const prepareElectronRuntimeSource = fs.readFileSync(new URL('../scripts/prepare-electron-runtime.mjs', import.meta.url), 'utf8');
const serverChildSource = fs.readFileSync(new URL('../electron/server-child.ts', import.meta.url), 'utf8');
const sharedTerminalManagerSource = fs.readFileSync(new URL('../src/lib/terminal/shared-terminal-manager.ts', import.meta.url), 'utf8');
const codexOverlaySource = fs.readFileSync(new URL('../src/lib/terminal/codex-overlay.ts', import.meta.url), 'utf8');
const hookReceiverSource = fs.readFileSync(new URL('../src/lib/cli/hook-receiver.ts', import.meta.url), 'utf8');

test('terminal feature declares browser UI and server PTY dependencies', () => {
  assert.equal(packageJson.dependencies['@xterm/xterm'], '6.1.0-beta.289');
  assert.equal(packageJson.dependencies['@xterm/headless'], '6.1.0-beta.289');
  assert.equal(packageJson.dependencies['@xterm/addon-fit'], '0.12.0-beta.289');
  assert.equal(packageJson.dependencies['@xterm/addon-search'], '0.17.0-beta.289');
  assert.equal(packageJson.dependencies['@xterm/addon-serialize'], '0.15.0-beta.289');
  assert.equal(packageJson.dependencies['@xterm/addon-unicode11'], '0.10.0-beta.289');
  assert.equal(packageJson.dependencies['@xterm/addon-web-links'], '0.13.0-beta.289');
  assert.equal(packageJson.dependencies['@xterm/addon-webgl'], '0.20.0-beta.288');
  assert.ok(packageJson.dependencies['node-pty']);
});

test('plain and OSC 8 terminal links share the validated Electron external URL bridge', () => {
  assert.match(
    terminalSurfaceSource,
    /const \{ webLinkHandler, oscLinkHandler \} = createTerminalExternalLinkHandlers\(\)/,
  );
  assert.match(terminalSurfaceSource, /linkHandler: oscLinkHandler/);
  assert.match(terminalSurfaceSource, /new WebLinksAddon\(webLinkHandler\)/);
  assert.match(
    electronPreloadSource,
    /openExternalUrl: \(url: string\) => ipcRenderer\.invoke\('shell-open-external-url', url\)/,
  );
  assert.match(
    electronMainSource,
    /ipcMain\.handle\('shell-open-external-url',[\s\S]*normalizeExternalHttpUrl\(rawUrl\)[\s\S]*shell\.openExternal\(targetUrl\)/,
  );
});

test('Claude PTY resumes persisted history and native fork provider sessions', () => {
  assert.match(
    routingSource,
    /resolveTerminalProviderSessionReference\(/,
  );
  assert.match(
    routingSource,
    /const resume = providerSession\.nativeFork[\s\S]*sessionHistory\.historyExists\(structured\.sessionId\)/,
  );
  assert.doesNotMatch(routingSource, /isTerminalLaunched/);
  assert.doesNotMatch(hookReceiverSource, /markTerminalLaunched/);
});

test('terminal exposes complete light and dark color palettes', () => {
  assert.match(terminalThemeSource, /export const TERMINAL_DARK_THEME/);
  assert.match(terminalThemeSource, /background: '#161616'/);
  assert.match(terminalThemeSource, /export const TERMINAL_LIGHT_THEME/);
  assert.match(terminalThemeSource, /background: '#fafaf9'/);
  assert.match(terminalThemeSource, /black: '#ecece8'/);
  for (const color of [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'brightBlack',
    'brightRed',
    'brightGreen',
    'brightYellow',
    'brightBlue',
    'brightMagenta',
    'brightCyan',
    'brightWhite',
  ]) {
    assert.match(terminalThemeSource, new RegExp(`${color}:`));
  }
});

test('mounted terminals synchronize app theme changes through the PTY appearance protocol', () => {
  assert.match(terminalPanelSource, /const isDark = useIsDark\(\)/);
  assert.match(terminalPanelSource, /theme: getTerminalTheme\(isDark, selectedThemePreset\)/);
  assert.match(terminalSurfaceSource, /theme: TesseraTerminalTheme/);
  assert.match(terminalSurfaceSource, /this\.theme = \{ \.\.\.options\.theme \}/);
  assert.doesNotMatch(terminalSurfaceSource, /private theme = getTerminalTheme\(true\)/);
  assert.match(
    terminalPanelSource,
    /surface\.setTheme\(\s*getTerminalTheme\(isDark, selectedThemePreset\),\s*isDark \? 'dark' : 'light',?\s*\)/,
  );
  assert.match(terminalSurfaceSource, /setTheme\(theme: TesseraTerminalTheme, mode: TerminalColorSchemeMode\)/);
  assert.match(terminalSurfaceSource, /this\.terminal\.options\.theme = this\.theme/);
  assert.match(terminalSurfaceSource, /theme: this\.theme/);
  assert.match(terminalSurfaceSource, /minimumContrastRatio: 4\.5/);
  assert.match(terminalSurfaceSource, /appearance: \{/);
  assert.match(terminalManagerSource, /createTerminalAppearanceController/);
  assert.match(messageTypesSource, /appearance\?: TerminalAppearance/);
  assert.match(messageTypesSource, /type: 'terminal_set_appearance'/);
  assert.match(
    terminalPanelSource,
    /}, \[panelId, sessionOwned, surface, tabId, terminalId, terminalSessionId\]\);/,
  );
});

test('terminal typography follows Tessera appearance settings and xterm owns scrolling', () => {
  assert.match(terminalPanelSource, /getTerminalFontSize\(fontScale\)/);
  assert.match(terminalPanelSource, /surface\.setFontSize\(terminalFontSize\)/);
  assert.match(terminalSurfaceSource, /fontSize: this\.fontSize/);
  assert.match(terminalSurfaceSource, /scrollbar: \{/);
  assert.match(terminalSurfaceSource, /showScrollbar: true/);
  assert.match(terminalSurfaceSource, /width: 7/);
  assert.match(terminalCssSource, /\.tessera-terminal-surface \.xterm-viewport/);
  assert.match(terminalCssSource, /overflow-y: scroll !important/);
  assert.match(terminalCssSource, /scrollbar-width: none/);
  assert.match(terminalCssSource, /\.xterm-scrollable-element > \.xterm-scrollbar > \.xterm-slider/);
  assert.doesNotMatch(
    terminalCssSource,
    /\.xterm-scrollbar\.xterm-vertical\s*{[^}]*opacity:\s*1\s*!important/s,
  );
  assert.match(terminalThemeSource, /scrollbarSliderBackground/);
  assert.match(terminalThemeSource, /overviewRulerBorder: 'transparent'/);
  assert.doesNotMatch(terminalCssSource, /::-webkit-scrollbar-thumb/);
  assert.doesNotMatch(terminalPanelSource, /TerminalScrollbar/);
  assert.doesNotMatch(terminalPanelSource, /scrollMetrics/);
});

test('mounted terminal DOM order stays stable when LRU activation order changes', () => {
  assert.match(tabPanelHostSource, /orderMountedTabIds\(tabs, lruTabIds\)/);
  assert.match(tabPanelHostSource, /mountedTabIds\.map/);
  assert.doesNotMatch(tabPanelHostSource, /\{lruTabIds\.map/);
});

test('terminal routes modified keys through an explicit input policy before xterm encoding', () => {
  assert.match(terminalSurfaceSource, /attachCustomKeyEventHandler\(\(event\) =>/);
  assert.match(terminalSurfaceSource, /resolveTerminalInputAction\(event, inputContext\)/);
  assert.match(terminalSurfaceSource, /event\.preventDefault\(\)/);
  assert.match(terminalSurfaceSource, /this\.sendInput\(action\.data\)/);
  assert.match(terminalSurfaceSource, /return false/);
});

test('terminal preserves scroll position on resize and exposes the shared latest-output control', () => {
  assert.match(terminalSurfaceSource, /new TerminalScrollController\(terminal\)/);
  assert.match(terminalSurfaceSource, /requestStableFit/);
  assert.match(terminalSurfaceSource, /captureRestorePoint/);
  assert.match(terminalSurfaceSource, /restoreAfterLayout/);
  assert.match(
    terminalSurfaceSource,
    /private fitAndResize\([\s\S]*?this\.recoverRendererPresentation\(\)/,
  );
  assert.match(
    terminalSurfaceSource,
    /private recoverRendererPresentation\(\): void \{[\s\S]*?this\.refreshTerminalViewport\(\)[\s\S]*?sharedTerminalRenderRecovery\.request\(\)/,
  );
  assert.match(terminalSurfaceSource, /terminal\.onScroll/);
  assert.match(terminalScrollControllerSource, /'follow-output' \| 'pinned-viewport'/);
  assert.match(terminalScrollControllerSource, /registerMarker/);
  assert.match(terminalScrollControllerSource, /LayoutSettleRunner/);
  assert.match(layoutSettleRunnerSource, /requestAnimationFrame/);
  assert.match(terminalPanelSource, /!isAtBottom/);
  assert.match(terminalPanelSource, /surface\.scrollToBottom\(\)/);
  assert.match(terminalPanelSource, /terminal-scroll-to-bottom-button/);
  assert.match(scrollToBottomButtonSource, /aria-label=\{title\}/);
});

test('single-panel terminal sessions omit only the redundant session header', () => {
  assert.match(chatAreaSource, /shouldShowSessionHeader\(\{ isTerminalSession, isSinglePanel \}\)/);
  assert.match(chatAreaSource, /<Header/);
  assert.match(chatAreaSource, /search=\{\{/);
});

test('terminal image paste crosses the Electron clipboard boundary through a narrow preload API', () => {
  assert.match(electronMainSource, /getTerminalClipboardKind\(clipboard\)/);
  assert.match(electronMainSource, /readTerminalClipboard\(clipboard\)/);
  assert.match(electronPreloadSource, /ipcRenderer\.sendSync\('get-terminal-clipboard-kind'\)/);
  assert.match(electronPreloadSource, /readTerminalClipboard:/);
  assert.match(electronPreloadSource, /ipcRenderer\.invoke\('read-terminal-clipboard'\)/);
  assert.match(terminalSurfaceSource, /pasteTerminalClipboard\(payload/);
  assert.match(terminalSurfaceSource, /uploadTerminalClipboardImage/);
  assert.match(terminalSurfaceSource, /terminal\.paste\(data\)/);
});

test('terminal websocket protocol covers process lifecycle', () => {
  for (const type of [
    'terminal_create',
    'terminal_detach',
    'terminal_release_preview',
    'terminal_input',
    'terminal_resize',
    'terminal_close',
    'terminal_started',
    'terminal_prefill_written',
    'terminal_prefill_cancelled',
    'terminal_snapshot',
    'terminal_output',
    'terminal_exit',
    'terminal_error',
    'terminal_session_runtime',
    'terminal_session_rebound',
    'terminal_session_runtime_snapshot',
  ]) {
    assert.match(messageTypesSource, new RegExp(`type: '${type}'`));
  }
});

test('terminal launch success is acknowledged only after the slash prefill is written', () => {
  assert.match(terminalManagerSource, /type: 'terminal_prefill_written'/);
  assert.match(terminalManagerSource, /type: 'terminal_prefill_cancelled'/);
  assert.match(terminalSurfaceSource, /message\.type === 'terminal_prefill_written'/);
  assert.match(terminalSurfaceSource, /message\.type === 'terminal_prefill_cancelled'/);
  assert.match(terminalSurfaceSource, /dispatchTerminalLaunchResult/);
});

test('terminal messages route through the connection-scoped server terminal manager', () => {
  assert.match(routingSource, /const manager = bindTerminalSender\(sendToConnection\)/);
  assert.match(routingSource, /await manager\.create\(\{/);
  assert.match(routingSource, /case 'terminal_create':/);
  assert.match(routingSource, /case 'terminal_release_preview':/);
  assert.match(routingSource, /case 'terminal_input':/);
  assert.match(routingSource, /case 'terminal_resize':/);
  assert.match(routingSource, /case 'terminal_close':/);
});

test('provider terminals keep their native alternate-screen behavior', () => {
  assert.doesNotMatch(providerTerminalLaunchSource, /CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN/);
  assert.doesNotMatch(routingSource, /buildProviderTerminalEnv/);
});

test('all provider terminals use the shared Orca-style TUI wheel reporting path', () => {
  assert.match(
    terminalSurfaceSource,
    /attachTerminalMouseWheelMultiplier\(terminal\)/,
  );
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
  assert.doesNotMatch(terminalLaunchIntentSource, /args: \['fork', threadId\]/);
  assert.match(terminalLaunchIntentSource, /args: \['resume', threadId\]/);
  assert.match(terminalLaunchIntentSource, /isCodexSlashCommandAvailable/);
});

test('handoff ownership is locked and released on every terminal lifecycle exit', () => {
  assert.match(terminalHandoffLockSource, /acquireTerminalHandoffLock/);
  assert.match(terminalHandoffLockSource, /isSessionHandedOffToTerminal/);
  assert.match(terminalManagerSource, /releaseTerminalHandoffByTerminal\(options\.userId, options\.terminalId\)/);
  assert.match(terminalManagerSource, /releaseTerminalHandoffByTerminal\(runtime\.userId, runtime\.terminalId\)/);
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
  assert.match(sessionOrchestratorSource, /withExclusiveTesseraSessionOperation\(sessionId/);
  assert.match(sessionArchiveSource, /withExclusiveTesseraSessionOperation\(sessionId/);
  assert.match(archiveServiceSource, /withExclusiveTesseraSessionOperation\(sessionId/);
  assert.match(archiveServiceSource, /withExclusiveTesseraSessionOperations\(task\.sessions\.map/);
  assert.match(archiveServiceSource, /beginTesseraSessionOperations\(item\.sessions\.map/);
  assert.match(archiveServiceSource, /endTesseraSessionOperations\(acquired\)/);
  assert.match(sessionArchiveRouteSource, /isTerminalHandoffConflictError/);
  assert.match(sessionArchiveRouteSource, /\? 409/);
  assert.match(taskArchiveRouteSource, /isTerminalHandoffConflictError/);
  assert.match(taskArchiveRouteSource, /\? 409/);
});

test('terminal prefill strips control characters and never appends Enter', () => {
  assert.match(terminalManagerSource, /replace\(\/\[\\x00-\\x1f\\x7f-\\x9f\]\+\/g, ' '\)/);
  assert.match(terminalManagerSource, /processHandle\.write\(sanitized\)/);
  assert.doesNotMatch(terminalManagerSource, /processHandle\.write\(`\$\{sanitized\}\\[rn]`\)/);
});

test('terminal host is shared across server module graphs and validates filesystem identities', () => {
  assert.match(sharedTerminalManagerSource, /Symbol\.for\('tessera\.terminalManager'\)/);
  assert.match(routingSource, /SAFE_TERMINAL_ID/);
  assert.match(routingSource, /Invalid terminal identity/);
  assert.match(codexOverlaySource, /Invalid terminal id for Codex overlay/);
});

test('packaged Electron child exposes the authenticated terminal hook endpoint', () => {
  assert.match(serverChildSource, /handleHookRequest/);
  assert.match(serverChildSource, /req\.url\?\.split\('\?'\)\[0\] === '\/__tessera\/hook'/);
});

test('panels can own terminal process identity separately from agent sessions', () => {
  assert.match(panelTypesSource, /terminalId\?: string \| null/);
});

test('websocket disconnect detaches surfaces without killing terminal processes', () => {
  assert.match(wsServerSource, /terminalManager\.detachConnection\(ws\.connectionId\)/);
  assert.doesNotMatch(wsServerSource, /terminalManager\.closeAllForUser\(userId\)/);
  assert.match(wsServerSource, /terminalManager\.shutdownAll\(\)/);
});

test('terminal runtime lifecycle is broadcast and replayed to session clients', () => {
  assert.match(sharedTerminalManagerSource, /type: 'terminal_session_runtime'/);
  assert.match(sharedTerminalManagerSource, /type: 'terminal_session_rebound'/);
  assert.match(wsServerSource, /bindTerminalRuntimeSender/);
  assert.match(wsServerSource, /type: 'terminal_session_runtime_snapshot'/);
  assert.match(wsServerSource, /terminalManager\.getActiveSessionIds\(userId\)/);
});

test('terminal cwd is server validated before spawning a PTY', () => {
  assert.match(terminalManagerSource, /resolveAllowedTerminalCwd/);
  assert.match(terminalResolverSource, /getVisibleProjects/);
  assert.match(terminalResolverSource, /getSession/);
  assert.match(terminalResolverSource, /Terminal cwd must be inside a registered project or active worktree/);
  assert.match(terminalLaunchIntentSource, /readSessionLaunchCwd/);
  assert.match(terminalManagerSource, /cwd: options\.launchSpec\?\.cwd \?\? options\.cwd/);
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
  assert.match(terminalManagerSource, /this\.terminals\.get\(key\) === runtime/);
});

test('pending terminal startup can be cancelled and duplicate IDs are single-flight', () => {
  assert.match(terminalManagerSource, /openingTerminals = new Map/);
  assert.match(terminalManagerSource, /openingByTerminalKey = new Map/);
  assert.match(terminalManagerSource, /hasOrIsOpening/);
  assert.match(terminalManagerSource, /preventSessionOpen/);
});

test('launched TUIs exit instead of falling through to a command shell', () => {
  assert.match(terminalResolverSource, /const inner = `exec \$\{buildPosixCommand/);
  assert.match(terminalResolverSource, /`exec \$\{buildPosixCommand\(launch\.program, launch\.args\)\}`/);
  assert.match(terminalResolverSource, /args: launch \? \['\/c'/);
  assert.doesNotMatch(terminalResolverSource, /NoExit/);
  assert.match(terminalManagerSource, /runtime\.cancelPrefill\?\.\(\)/);
});

test('terminal launch intent is runtime validated before classification', () => {
  assert.match(terminalLaunchIntentSource, /options\.intent\.kind !== 'claude-slash'/);
  assert.match(terminalLaunchIntentSource, /typeof options\.intent\.commandInput !== 'string'/);
});

test('terminal client subscribes before creating the server process', () => {
  assert.ok(
    terminalSurfaceSource.indexOf('subscribeServerMessages') <
      terminalSurfaceSource.indexOf('wsClient.createTerminal'),
  );
  assert.match(terminalPanelSource, /connectionStatus !== 'connected'/);
  assert.match(terminalSurfaceSource, /attachedConnectionGeneration/);
  assert.match(wsClientSource, /createTerminal\(args: \{/);
  assert.match(wsClientSource, /\}\): boolean \{/);
});

test('terminal creation is gated by visible tab, not active split-panel focus', () => {
  assert.doesNotMatch(terminalPanelSource, /useSessionStore\(\(state\) => state\.activeSessionId\)/);
  assert.doesNotMatch(terminalPanelSource, /useSessionStore\.getState\(\)\.activeSessionId/);
  assert.match(terminalPanelSource, /!isTabActive/);
  assert.match(terminalPanelSource, /surface\.ensureConnected\(\)\.then/);
  assert.match(terminalPanelSource, /connected && isPanelActive/);
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
  assert.match(terminalPanelSource, /\{!sessionOwned && \(/);
  assert.match(terminalPanelSource, /data-testid="terminal-panel-drag-handle"/);
  assert.match(terminalPanelSource, /data-testid="terminal-panel-empty-drag-region"/);
  assert.match(terminalPanelSource, /draggable/);
});

test('terminal panels offer only safe restarts for unsupported live theme changes', () => {
  assert.match(terminalPanelSource, /themeRestartRequired \|\| \(sessionOwned && status !== 'running'\)/);
  assert.match(terminalPanelSource, /terminal-session-status-banner/);
  assert.match(terminalPanelSource, /terminal-session-restart-banner/);
  assert.match(terminalPanelSource, /terminal-theme-restart-banner/);
  assert.match(terminalPanelSource, /canRestart \|\| \(themeRestartRequired && themeRestartAllowed\)/);
  assert.match(terminalPanelSource, />\s*Restart\s*</);
  assert.match(terminalSurfaceSource, /pendingLaunch\?\.locksSourceSession && pendingLaunch\.intent/);
  assert.match(terminalSurfaceSource, /intent: this\.themeRestartLaunchIntent/);
  assert.match(terminalSurfaceSource, /if \(message\.restartIntent\) this\.themeRestartLaunchIntent = message\.restartIntent/);
  assert.match(terminalManagerSource, /restartIntent: restartAllowed \? runtime\.appearanceRestartIntent : undefined/);
  assert.match(routingSource, /appearanceChangePolicy === 'restart' && launchSpec\?\.handoffSessionId/);
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

test('terminal remount reuses warm xterm and cold attach uses a targeted snapshot', () => {
  assert.match(terminalSurfaceSource, /getParkingLot\(\)\.appendChild\(this\.root\)/);
  assert.match(terminalSurfaceSource, /host\.appendChild\(this\.root\)/);
  assert.match(terminalManagerSource, /let runtime = this\.terminals\.get\(key\)/);
  assert.match(terminalManagerSource, /await this\.attachRuntime\(runtime/);
  assert.match(terminalManagerSource, /type: 'terminal_snapshot'/);
  assert.match(terminalManagerSource, /surfaceId: subscriber\.surfaceId/);
});

test('revealing a warm terminal rebuilds the shared WebGL atlas and every viewport', () => {
  assert.match(terminalSurfaceSource, /function recoverAllTerminalRenderers\(\)/);
  assert.match(
    terminalSurfaceSource,
    /setHostVisible\(visible: boolean\)[\s\S]*?requestAnimationFrame\(\(\) => \{[\s\S]*?recoverAllTerminalRenderers\(\)/,
  );
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

test('WSL terminals cross hook coordinates and overlay homes via WSLENV', () => {
  // 훅 좌표 3종은 값 그대로(플래그 없음) 크로스.
  assert.match(terminalManagerSource, /\{ name: 'TESSERA_PANE_TOKEN' \}/);
  assert.match(terminalManagerSource, /\{ name: 'TESSERA_SESSION_ID' \}/);
  assert.match(terminalManagerSource, /\{ name: 'TESSERA_HOOK_PORT' \}/);
  // 오버레이 홈은 값이 이미 게스트 POSIX 경로('/')면 /p 변환을 붙이지 않는다 —
  // Windows 경로일 때만 경로 변환(orca endpointFlag 미러).
  assert.match(terminalManagerSource, /\{ name: 'CODEX_HOME', path: !terminalEnv\.CODEX_HOME\?\.startsWith\('\/'\) \}/);
  assert.match(terminalManagerSource, /\{ name: 'OPENCODE_CONFIG_DIR', path: !terminalEnv\.OPENCODE_CONFIG_DIR\?\.startsWith\('\/'\) \}/);
});

test('codex overlay placement and hook style follow the terminal runtime', () => {
  // win32 + agentEnvironment 'wsl' → 게스트 파일시스템 오버레이(게스트 심링크),
  // 그 외 → 호스트 오버레이. 훅 스타일도 같은 판정을 공유한다(스폰과 일치).
  assert.match(routingSource, /wslTerminalRuntime = getRuntimePlatform\(\) === 'win32' && agentEnvironment === 'wsl'/);
  assert.match(routingSource, /await createCodexOverlayInWsl\(terminalId, hookCommandStyle\)/);
  assert.match(routingSource, /createCodexOverlay\(terminalId, hookCommandStyle\)/);
  assert.match(routingSource, /buildClaudeHookSettingsJson\(hookCommandStyle\)/);
  // 오버레이 실패는 제네릭 error가 아니라 terminal_error로 표면에 알린다.
  assert.match(routingSource, /Failed to prepare the Codex overlay/);
});

test('terminal startup normalizes inherited color capability flags', () => {
  assert.match(terminalManagerSource, /normalizeTerminalColorEnv\(nextEnv\)/);
  assert.match(terminalManagerSource, /\{ name: 'TERM' \}/);
  assert.match(terminalManagerSource, /\{ name: 'COLORTERM' \}/);
  assert.match(terminalManagerSource, /\{ name: 'TERM_PROGRAM' \}/);
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

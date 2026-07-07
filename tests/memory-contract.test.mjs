import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const memoryLibSource = fs.readFileSync(new URL('../src/lib/memory/claude-memory.ts', import.meta.url), 'utf8');
const codexMemorySource = fs.readFileSync(new URL('../src/lib/memory/codex-memory.ts', import.meta.url), 'utf8');
const opencodeMemorySource = fs.readFileSync(new URL('../src/lib/memory/opencode-memory.ts', import.meta.url), 'utf8');
const memoryProviderSource = fs.readFileSync(new URL('../src/lib/memory/memory-provider.ts', import.meta.url), 'utf8');
const memoryListRouteSource = fs.readFileSync(new URL('../src/app/api/sessions/[id]/memory/route.ts', import.meta.url), 'utf8');
const memoryFileRouteSource = fs.readFileSync(new URL('../src/app/api/sessions/[id]/memory/file/route.ts', import.meta.url), 'utf8');
const memoryPanelSource = fs.readFileSync(new URL('../src/components/memory/memory-panel.tsx', import.meta.url), 'utf8');
const memoryFileTabSource = fs.readFileSync(new URL('../src/components/memory/memory-file-tab.tsx', import.meta.url), 'utf8');
const specialSessionSource = fs.readFileSync(new URL('../src/lib/workspace-tabs/special-session.ts', import.meta.url), 'utf8');
const gitPanelComponentSource = fs.readFileSync(new URL('../src/components/git/git-panel.tsx', import.meta.url), 'utf8');
const tabStoreSource = fs.readFileSync(new URL('../src/stores/tab-store.ts', import.meta.url), 'utf8');
const monacoEditorSource = fs.readFileSync(new URL('../src/components/workspace/workspace-monaco-editor.tsx', import.meta.url), 'utf8');

test('memory slug matches the Claude CLI path encoding (non-alphanumeric to dash)', () => {
  assert.match(memoryLibSource, /replace\(\/\[\^a-zA-Z0-9\]\/g, "-"\)/);
});

test('memory file names are restricted to plain .md names with no path separators', () => {
  assert.match(memoryLibSource, /\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\*\\\.md\$/);
  assert.match(memoryLibSource, /path\.dirname\(absolutePath\) !== path\.normalize\(memoryDir\)/);
  assert.match(codexMemorySource, /validateCodexMemoryRelativePath/);
  assert.match(codexMemorySource, /relativePath\.includes\(".."\)/);
  assert.match(codexMemorySource, /Unsupported Codex memory path/);
});

test('memory fs operations are bounded by a deadline that maps to 504', () => {
  assert.match(memoryLibSource, /export function withFsDeadline/);
  assert.match(memoryLibSource, /filesystem_timeout/);
  assert.match(memoryLibSource, /504/);
  assert.doesNotMatch(memoryLibSource, /await handle\.close\(\);/);
  assert.match(memoryFileRouteSource, /withFsDeadline\(fs\.stat\(/);
  assert.match(memoryFileRouteSource, /withFsDeadline\(fs\.readFile\(/);
  assert.match(memoryFileRouteSource, /withFsDeadline\(fs\.writeFile\(/);
  assert.match(memoryFileRouteSource, /withFsDeadline\(fs\.unlink\(/);
});

test('memory dir resolution uses provider-specific environment-aware config dirs', () => {
  assert.match(memoryLibSource, /resolveClaudeConfigDirForEnvironment/);
  assert.doesNotMatch(memoryLibSource, /homedir\(\)/);
  assert.match(codexMemorySource, /resolveCodexHomeForEnvironment/);
  assert.match(codexMemorySource, /process\.env\.CODEX_HOME/);
  assert.match(codexMemorySource, /path\.join\(homedir\(\), "\.codex"\)/);
});

test('memory/context is gated to Claude Code, Codex, and OpenCode sessions on both client and server', () => {
  assert.match(memoryLibSource, /isClaudeMemoryProvider\(session\.provider\)/);
  assert.match(memoryProviderSource, /CODEX_PROVIDER_ID = "codex"/);
  assert.match(memoryProviderSource, /OPENCODE_PROVIDER_ID = "opencode"/);
  assert.match(memoryProviderSource, /getMemoryProviderKind/);
  assert.match(memoryProviderSource, /supportsMemoryPanel/);
  assert.match(codexMemorySource, /getMemoryProviderKind\(session\.provider\) !== "codex"/);
  assert.match(opencodeMemorySource, /getMemoryProviderKind\(session\.provider\) !== "opencode"/);
  assert.match(memoryLibSource, /unsupported_provider/);
  assert.match(codexMemorySource, /unsupported_provider/);
  assert.match(opencodeMemorySource, /unsupported_provider/);
  // Client: the Context tab is shown for providers supported by the shared gate.
  assert.match(gitPanelComponentSource, /const showMemoryTab = supportsMemoryPanel\(sessionProvider\);/);
  assert.match(gitPanelComponentSource, /\{showMemoryTab \? \(/);
  assert.match(gitPanelComponentSource, /!showMemoryTab && activePanelTab === "memory"/);
  assert.match(gitPanelComponentSource, /t\("gitPanel\.tabs\.context"\)/);
});

test('WSL slug is computed from the CLI cwd, not the raw stored Windows path', () => {
  // On a WSL-on-Windows bridge the CLI runs in the WSL-native translation of
  // the stored Windows path; the slug must match that, or the directory is
  // resolved as missing.
  assert.match(memoryLibSource, /normalizeCwdForCliEnvironment\(candidate\.workspaceRoot, environment\)/);
  assert.match(memoryLibSource, /claudeProjectPathSlug\(cliCwd\)/);
});

test('memory routes authenticate and report errors in the shared shape', () => {
  for (const source of [memoryListRouteSource, memoryFileRouteSource]) {
    assert.match(source, /requireAuthenticatedUserId/);
    assert.match(source, /jsonError/);
  }
});

test('saving detects concurrent edits via baseMtimeMs and 409', () => {
  assert.match(memoryFileRouteSource, /baseMtimeMs/);
  assert.match(memoryFileRouteSource, /currentStat\.mtimeMs !== body\.baseMtimeMs/);
  assert.match(memoryFileRouteSource, /"conflict", "File changed on disk", 409/);
});

test('provider instruction files are exposed as file targets by kind', () => {
  // Claude resolves CLAUDE.md guidelines; Codex and OpenCode resolve AGENTS files.
  assert.match(memoryLibSource, /resolveGuidelineTargets/);
  assert.match(codexMemorySource, /resolveCodexGuidelineTargets/);
  assert.match(opencodeMemorySource, /resolveOpenCodeGuidelineTargets/);
  assert.match(codexMemorySource, /AGENTS\.override\.md/);
  assert.match(codexMemorySource, /AGENTS\.md/);
  assert.match(codexMemorySource, /Shadowed by override/);
  assert.match(opencodeMemorySource, /AGENTS\.md/);
  assert.match(opencodeMemorySource, /CLAUDE\.md/);
  assert.match(opencodeMemorySource, /Shadowed by AGENTS\.md/);
  assert.match(opencodeMemorySource, /Fallback active/);
  assert.match(memoryLibSource, /global-guideline/);
  assert.match(memoryLibSource, /project-guideline/);
  assert.match(memoryListRouteSource, /listGuidelines/);
  assert.match(memoryListRouteSource, /listCodexGuidelines/);
  assert.match(memoryListRouteSource, /listOpenCodeGuidelines/);
  // File route routes reads/writes by kind and provider.
  assert.match(memoryFileRouteSource, /function parseTargetKind/);
  assert.match(memoryFileRouteSource, /resolveGuidelineTarget/);
  assert.match(memoryFileRouteSource, /resolveCodexGuidelineTarget/);
  assert.match(memoryFileRouteSource, /resolveOpenCodeGuidelineTarget/);
  assert.match(memoryFileRouteSource, /fileName: "CLAUDE\.md"/);
  // Only memory entries can be created or deleted; CLAUDE.md is edit-only.
  assert.match(memoryFileRouteSource, /Only memory files can be created/);
  assert.match(memoryFileRouteSource, /Only memory files can be deleted/);
  // The panel shows guidelines in the flat file list.
  assert.match(memoryPanelSource, /data\.guidelines/);
});

test('Codex memories are shown as user-global memory with explanatory rows', () => {
  assert.match(codexMemorySource, /resolveCodexMemoryContext/);
  assert.match(codexMemorySource, /"memory_summary\.md"/);
  assert.match(codexMemorySource, /"MEMORY\.md"/);
  assert.match(codexMemorySource, /rollout_summaries/);
  assert.match(codexMemorySource, /extensions\/ad_hoc\/notes/);
  assert.match(codexMemorySource, /skills\/\$\{entry\.name\}\/SKILL\.md/);
  assert.match(codexMemorySource, /Global memory summary injected at session start/);
  assert.match(codexMemorySource, /Global memory registry used for search and indexing/);
  assert.match(codexMemorySource, /readOnly: true/);
  assert.match(memoryListRouteSource, /memoryScopeLabel: "User Global Memory"/);
  assert.match(memoryListRouteSource, /not per project/);
  assert.match(memoryListRouteSource, /instructionRoots: \{/);
});

test('OpenCode context follows the official rules manual and exposes no memory files', () => {
  assert.match(opencodeMemorySource, /resolveOpenCodeConfigDirForEnvironment/);
  assert.match(opencodeMemorySource, /path\.join\(homedir\(\), "\.config", "opencode"\)/);
  assert.match(opencodeMemorySource, /"AGENTS\.md"/);
  assert.match(opencodeMemorySource, /"CLAUDE\.md"/);
  assert.match(opencodeMemorySource, /"opencode\.json"/);
  assert.match(opencodeMemorySource, /parsed\.instructions/);
  assert.match(opencodeMemorySource, /configuredInstructionTargets/);
  assert.match(opencodeMemorySource, /\^https\?:\\\/\\\//);
  assert.match(opencodeMemorySource, /GLOB_PATTERN_CHARS/);
  assert.match(opencodeMemorySource, /path\.win32\.isAbsolute/);
  assert.match(opencodeMemorySource, /isWithinDirectory/);
  assert.match(opencodeMemorySource, /OPENCODE_DISABLE_CLAUDE_CODE/);
  assert.match(opencodeMemorySource, /OPENCODE_DISABLE_CLAUDE_CODE_PROMPT/);
  assert.match(opencodeMemorySource, /"shadowed-by-agents"/);
  assert.match(opencodeMemorySource, /"fallback-active"/);
  assert.match(opencodeMemorySource, /"disabled-by-env"/);
  assert.match(memoryListRouteSource, /if \(provider === "opencode"\)/);
  assert.match(memoryListRouteSource, /files: \[\]/);
  assert.match(memoryListRouteSource, /memoryScopeLabel: ""/);
  assert.match(memoryFileRouteSource, /unsupported_provider_memory/);
  assert.match(memoryPanelSource, /data\.provider === "opencode"/);
  assert.match(memoryPanelSource, /opencodeUserScopeDescription/);
  assert.match(memoryPanelSource, /opencodeProjectScopeDescription/);
});

test('creating a memory file is atomic against duplicates', () => {
  assert.match(memoryFileRouteSource, /flag: "wx"/);
  assert.match(memoryFileRouteSource, /already_exists/);
});

test('memory UI loads through the timeout-aware fetch', () => {
  assert.match(memoryPanelSource, /fetchWithTimeout\(/);
  assert.match(memoryPanelSource, /isTimeoutError/);
  assert.match(memoryFileTabSource, /fetchWithTimeout\(/);
  assert.match(memoryFileTabSource, /isTimeoutError/);
  assert.doesNotMatch(memoryPanelSource, /await fetch\(/);
  assert.doesNotMatch(memoryFileTabSource, /await fetch\(/);
});

test('memory panel omits the redundant header controls and feedback type label', () => {
  assert.doesNotMatch(memoryPanelSource, /Search memory files/);
  assert.doesNotMatch(memoryPanelSource, /memory-create-btn/);
  assert.doesNotMatch(memoryPanelSource, /memory-refresh-btn/);
  assert.match(memoryPanelSource, /type VisibleMemoryEntryType = Exclude<MemoryEntryType, "feedback">;/);
  assert.match(memoryPanelSource, /type === "feedback" \? null : type/);
});

test('memory panel groups files by visible scope while keeping folder paths visible', () => {
  assert.match(memoryPanelSource, /t\("memoryPanel\.sections\.userScopeTitle"\)/);
  assert.match(memoryPanelSource, /t\("memoryPanel\.sections\.projectScopeTitle"\)/);
  assert.match(memoryPanelSource, /t\("memoryPanel\.sections\.codexGlobalMemoryTitle"\)/);
  assert.match(memoryPanelSource, /t\("memoryPanel\.sections\.claudeProjectMemoryTitle"\)/);
  assert.match(memoryPanelSource, /t\("memoryPanel\.sections\.opencodeUserScopeDescription"\)/);
  assert.match(memoryPanelSource, /t\("memoryPanel\.sections\.opencodeProjectScopeDescription"\)/);
  assert.match(memoryPanelSource, /key: "user-global-memory"/);
  assert.match(memoryPanelSource, /t\("memoryPanel\.sections\.rolloutSummariesTitle"\)/);
  assert.match(memoryPanelSource, /t\("memoryPanel\.sections\.adHocNotesTitle"\)/);
  assert.match(memoryPanelSource, /t\("memoryPanel\.sections\.memorySkillsTitle"\)/);
  assert.match(memoryPanelSource, /data\.instructionRoots\.user/);
  assert.match(memoryPanelSource, /data\.instructionRoots\.project \?\? ""/);
  assert.match(memoryPanelSource, /folderPath: data\.memoryDir/);
  assert.match(memoryPanelSource, /title=\{section\.folderPath\}/);
  assert.match(memoryPanelSource, /section\.key === "user-scope"/);
  assert.match(memoryPanelSource, /section\.key === "project-scope"/);
  assert.match(memoryPanelSource, /t\("memoryPanel\.empty\.noProjectInstructions"\)/);
  assert.match(memoryPanelSource, /const hasVisibleRows = sections\.length > 0/);
});

test('memory rows are visually nested under scopes and reuse the file context menu', () => {
  assert.match(memoryPanelSource, /WorkspaceFileContextMenu/);
  assert.match(memoryPanelSource, /onContextMenu=\{\(event\) => \{/);
  assert.match(memoryPanelSource, /absolutePath: row\.path/);
  assert.match(memoryPanelSource, /canOpenFile: true/);
  assert.match(memoryPanelSource, /className="flex w-full min-w-0 items-start gap-2 py-1\.5 pl-8 pr-8 text-left"/);
  assert.doesNotMatch(memoryPanelSource, /not created/);
});

test('memory file paths use native row tooltips without a custom hover preview', () => {
  assert.match(memoryPanelSource, /title=\{row\.path\}/);
  assert.doesNotMatch(memoryPanelSource, /group-hover:delay-700/);
  assert.doesNotMatch(memoryPanelSource, /line-clamp-2 break-all/);
});

test('background refreshes never clobber unsaved memory edits', () => {
  assert.match(memoryFileTabSource, /if \(options\?\.silent && \(dirtyRef\.current \|\| activeLoadsRef\.current > 0\)\) return;/);
  assert.match(memoryFileTabSource, /if \(options\?\.silent && dirtyRef\.current\) return;/);
});

test('saving keeps edits typed while the PUT was in flight', () => {
  // Functional clear: only drop the draft when it still equals the saved value.
  assert.match(memoryFileTabSource, /setDraft\(\(current\) => \(current === draft \? null : current\)\);/);
  // Invalidate loads started before the save so their responses are discarded.
  assert.match(memoryFileTabSource, /requestSeqRef\.current \+= 1;\s*\n\s*setState\(/);
});

test('save shortcut is scoped to the tab, not the window', () => {
  assert.match(memoryFileTabSource, /onKeyDown=\{handleSaveShortcut\}/);
  assert.doesNotMatch(memoryFileTabSource, /window\.addEventListener\("keydown"/);
});

test('unsaved edits pin a preview tab so it cannot be replaced silently', () => {
  assert.match(memoryFileTabSource, /pinTab\(location\.tabId\)/);
});

test('reads and writes stay pinned to the directory the first load resolved', () => {
  assert.match(memoryLibSource, /pinnedRoot/);
  assert.match(memoryFileRouteSource, /parseMemoryRootKey/);
  assert.match(memoryFileTabSource, /rootRef\.current = data\.root;/);
});

test('read-only memory files hide edit controls and are blocked server-side', () => {
  assert.match(memoryFileTabSource, /const readOnly = state\.data\?\.readOnly \?\? false/);
  assert.match(memoryFileTabSource, /state\.data && !readOnly/);
  assert.match(memoryFileTabSource, /readOnly=\{readOnly\}/);
  assert.match(memoryFileRouteSource, /if \(target\.readOnly\)/);
  assert.match(memoryFileRouteSource, /read_only_memory_file/);
});

test('monaco skips reverting self-originated values during sync', () => {
  assert.match(monacoEditorSource, /content !== lastEmittedValueRef\.current/);
});

test('memory file tabs participate in the special-session pipeline', () => {
  assert.match(specialSessionSource, /__memory-file__\|/);
  assert.match(specialSessionSource, /parseMemoryFileSessionId/);
  assert.match(specialSessionSource, /const name = memory\.fileName\.split/);
  assert.match(tabStoreSource, /parseMemoryFileSessionId/);
});

test('monaco onChange listener is editor-level so it survives model swaps', () => {
  assert.match(monacoEditorSource, /editor\.onDidChangeModelContent\(/);
  assert.match(monacoEditorSource, /latestPropsRef\.current\.onChange\?\.\(value\)/);
});

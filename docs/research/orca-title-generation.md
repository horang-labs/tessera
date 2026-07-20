# Orca title generation research

Checked against the official [`stablyai/orca`](https://github.com/stablyai/orca) repository at commit [`67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98`](https://github.com/stablyai/orca/commit/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98) on 2026-07-14.

## Conclusion

Orca has two separate naming systems that are easy to conflate:

1. **Agent terminal tab/session title:** deterministic, local string processing with **no LLM call**. It is currently **opt-in and off by default**. There is no second, LLM-backed tab-title option in the current source.
2. **New workspace / branch auto-rename:** LLM-backed generation through a configured agent CLI. It is **on by default**, starts on the first live `working` event with a prompt, and may take up to 60 seconds. For a folder workspace this generated branch slug is also used to create the workspace/sidebar display name.

For a Tessera-style conversation/session title, Orca's first system is the relevant comparison. The user's proposed design is therefore close to Orca's implementation strategy, but not to its current defaults: Orca has the fast deterministic implementation, yet keeps it off by default and offers no LLM refinement mode for tab titles.

### Local installed Orca check

The installed `/Applications/Orca.app` is version `1.4.137`. Its unpacked production artifact at `/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/shared/agent-tab-title.js` contains the same synchronous `deriveGeneratedTabTitle` implementation, including the 512-character scan limit and 40-character output cap (lines 3–110). This confirms the heuristic is shipped behavior, not only unbuilt repository code.

This machine's persisted Orca profile has both features enabled:

- `~/Library/Application Support/orca/profiles/local-default/orca-data.json`: `autoRenameBranchFromWork: true` at line 153 and `tabAutoGenerateTitle: true` at line 336.
- The legacy/root `~/Library/Application Support/orca/orca-data.json` also has the two values set to `true` at lines 97 and 266.

These are **current per-user values**, not product defaults. The upstream default remains `tabAutoGenerateTitle: false` and `autoRenameBranchFromWork: true`, as documented below. Thus this user's observed Orca behavior can look like fast auto-title is “the default” even though it was enabled in the saved profile.

## 1. Agent terminal tab/session titles

### Default and setting

- The setting is `tabAutoGenerateTitle`; its default is `false`. The type comment says generated titles are subjective, so they remain opt-in and manual renames represent stronger intent. [Default setting](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/shared/constants.ts#L341-L347), [type rationale](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/shared/types.ts#L2862-L2867)
- Settings exposes a single switch labelled “Auto-generate tab titles.” Its description explicitly says it derives a short stable tab name from the first known agent prompt and manual renames win. [Settings UI](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/renderer/src/components/settings/AgentsPane.tsx#L985-L1004), [copy](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/renderer/src/components/settings/agent-generated-tab-title-copy.ts#L9-L17)
- The implementing PR describes the behavior as “deterministically from the first known agent prompt, with no model call.” [PR #3224](https://github.com/stablyai/orca/pull/3224)
- A source search finds no `titleModel`, tab-title model selector, or LLM execution path connected to `tabAutoGenerateTitle`. The only call from title state to generation is the pure `deriveGeneratedTabTitle(prompt)` function. [Write path](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/renderer/src/store/slices/terminals.ts#L1583-L1609)

### Exact timing

The normal local Codex/Claude path is:

```text
agent emits UserPromptSubmit hook
  -> main normalizes/caches it as a working status with prompt
  -> main immediately sends agentStatus:set IPC
  -> renderer calls setAgentStatus(...)
  -> after that state write, renderer calls setGeneratedTabTitleFromAgentPrompt(...)
  -> deriveGeneratedTabTitle(prompt) runs synchronously
  -> generated title is written to tab state
```

- Hook prompt extraction reads the provider's `prompt`, `user_prompt`, `userPrompt`, and related fields and trims it. [Prompt extraction](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/shared/agent-hook-listener.ts#L394-L431)
- The main process records the status and invokes its listener directly, with no completion wait. [Status apply](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/main/agent-hooks/server.ts#L815-L830)
- The listener forwards `agentStatus:set` immediately to the renderer. [Main IPC](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/main/index.ts#L1025-L1057)
- Renderer IPC calls `setAgentStatus`. [Renderer IPC](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/renderer/src/hooks/useIpcEvents.ts#L3103-L3125)
- `setAgentStatus` retains the current status entry and then immediately calls `setGeneratedTabTitleFromAgentPrompt`; it does not require `done` or an assistant response. [Trigger after status update](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/renderer/src/store/slices/agent-status.ts#L1563-L1607)
- Agent launch paths that already know a prompt can seed a `working` status even earlier; Command Code has explicit seed paths because it lacks a prompt-start hook. [Initial launch status](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/renderer/src/components/terminal-pane/pty-connection.ts#L2551-L2574), [Command Code seed](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/renderer/src/lib/command-code-prompt-status-seed.ts#L4-L23)

Consequently, the title calculation itself has no network/process latency, timeout, retry, or post-response wait. Any delay is limited to when the agent/provider exposes the first prompt status event.

### Deterministic algorithm

`deriveGeneratedTabTitle`:

- scans at most the first 512 prompt characters;
- takes the first sentence/clause;
- strips URLs, Markdown punctuation, emoji/special characters, and common filler prefixes such as “please” and “can you”;
- preserves Unicode letters and numbers;
- promotes issue/PR/MR/ticket identifiers when present;
- capitalizes the result and truncates it to at most 40 characters, preferring a word boundary;
- returns `null` when no useful text remains.

[Algorithm and limits](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/shared/agent-tab-title.ts#L7-L128), [examples and empty-input behavior](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/shared/agent-tab-title.test.ts#L12-L111)

The title is normally first-write-wins: if a generated title already exists, later prompts do not replace it. An exception allows matching Orca orchestration metadata to upgrade a dispatched worker's raw prompt-derived title to the task/display label. [Write guards](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/renderer/src/store/slices/terminals.ts#L1583-L1634), [orchestration replacement](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/renderer/src/store/slices/agent-status.ts#L1563-L1607)

### Priority and fallback

Visible terminal-tab title priority is:

```text
manual custom title
  > quick-command label
  > generated title, only when setting is enabled
  > live PTY/agent title
  > caller fallback
```

[Resolution function](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/shared/tab-title-resolution.ts#L3-L28), [priority tests](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/shared/tab-title-resolution.test.ts#L4-L75)

Fallback behavior follows directly from that priority:

- setting off: the live PTY/agent title remains visible;
- algorithm returns `null`: no generated title is written, so the live title remains visible;
- manual rename or quick-command label exists: title generation refuses to overwrite it;
- no LLM fallback or refinement is attempted.

The generated title is persisted in terminal-tab session metadata and restored during hydration. [Session schema](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/shared/workspace-session-schema.ts#L65-L80), [hydration](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/renderer/src/store/slices/tabs-hydration.ts#L65-L93)

## 2. Workspace/sidebar title and branch auto-rename

This is a separate feature and is genuinely LLM-backed.

### Default and setting

- `autoRenameBranchFromWork` is `true` by default; migration logic also changes old unguarded profiles to on while preserving explicit opt-outs. [Default](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/shared/constants.ts#L189-L198), [normalization](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/shared/auto-rename-branch-from-work-settings.ts#L8-L20)
- Settings describes it as renaming an Orca-generated branch after an agent starts, never overwriting a user-named branch and never renaming after push. It also exposes the branch-name command template under Advanced. [Settings UI](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/renderer/src/components/settings/AutoRenameBranchFromWorkSetting.tsx#L125-L193)
- Source Control AI is itself on by default and follows the user's default supported agent/model unless explicitly configured. [AI defaults](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/shared/constants.ts#L390-L405), [operation agent resolution](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/shared/source-control-ai.ts#L1145-L1176)

### Timing and generation

- It fires on the first **live**, non-replay `working` event that has a prompt; it does not wait for the first turn to finish. In-flight and settled worktree sets deduplicate concurrent/later hook events. [First-work gates](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/main/agent-hooks/first-work-branch-rename.ts#L77-L148)
- It launches the configured agent CLI through shared Source Control AI generation machinery. The prompt asks for a 2–4 word lowercase kebab-case name and can include an assistant initial response if one is already available. [Prompt](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/shared/branch-name-from-work.ts#L94-L128), [generation call](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/main/text-generation/commit-message-text-generation.ts#L985-L1035)
- The generation timeout is 60 seconds. [Timeout constant and enforcement](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/main/text-generation/commit-message-text-generation.ts#L57-L58), [local timeout](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/main/text-generation/commit-message-text-generation.ts#L640-L646)
- For a non-git folder workspace, the same generated slug is humanized into the workspace/sidebar display name. [Folder workspace rename](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/main/agent-hooks/first-work-workspace-title-rename.ts#L9-L64), [display-name derivation](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/shared/display-name-from-work.ts#L56-L75)

### Fallback and retry

- Eligibility failures such as a user-chosen branch or an already-pushed branch are terminal skips; Orca preserves the existing name.
- Transient failures such as unavailable agent environment, detached HEAD, or generation failure return a retry-later verdict, allowing a later live status event to try again.
- Generation errors are stored for a visible failure badge. There is no deterministic branch/workspace-name fallback derived from the prompt; the pre-existing creature/workspace name remains until a retry succeeds or the user renames it.

[Eligibility and retry semantics](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/main/agent-hooks/first-work-branch-rename.ts#L150-L266), [folder generation failure path](https://github.com/stablyai/orca/blob/67fdb1c2b929927b07bdb2bfcdb66dc15f8a6f98/src/main/agent-hooks/first-work-workspace-title-rename.ts#L22-L64)

## Implication for Tessera

Orca's source supports this product direction for chat/session titles:

```text
immediately show deterministic title from first user message
  -> preserve manual rename as highest priority
  -> optionally launch LLM refinement in background
  -> keep deterministic title on timeout/failure
```

The first three steps are not Orca's exact tab-title implementation—Orca currently has no LLM refinement path—but they combine Orca's fast deterministic tab-title technique with a safer optional refinement layer. If Tessera adopts this, the deterministic title should be the default baseline, while LLM generation should be a separately named option rather than blocking the initial title.

---
name: tessera-cli
description: Operate Tessera-managed Projects, Worktrees, and Sessions through the injected version-matched control CLI. Use when an agent running inside Tessera needs to inspect its caller context, find a past Session the user half-remembers and show it in their Tessera window, create an isolated Worktree, launch or observe a Session, send a follow-up at a known input boundary, or stop a live runtime.
---

# Tessera CLI

Use Tessera's injected CLI only as a low-level resource-control interface. Keep the user's purpose and success criteria outside Tessera's resource model.

## Establish the managed context

1. Check that both `TESSERA_ENV=1` and a non-empty `TESSERA_CLI_COMMAND` are present. If either check fails, stop and explain that this is not a Tessera-managed Session.
2. Treat `TESSERA_CLI_COMMAND` as one executable path. Quote it for every invocation and never pass it through `eval` or split it into shell words.
3. Confirm the exact runtime and caller context before changing resources:

```sh
"$TESSERA_CLI_COMMAND" status --json
```

Use structured `data` and `error` objects instead of scraping human-readable output. Use the bridge's version-matched `--help` at the relevant command level when syntax is unclear; do not infer unsupported flags or rely on this skill as an exhaustive command reference. Never search for runtime descriptors, endpoints, ports, or credentials.

## Select resources safely

- Use `--current` only when `TESSERA_PROJECT_ID` was injected and `status --json` confirms that Project in the caller context.
- Otherwise select an existing Project by its exact ID. Display names and filesystem paths are not selectors.
- Create a Worktree only with an explicit new branch name and explicit start point. Never infer either value from the current shell, Project defaults, or UI state.
- Save the returned `worktreeId` and use that exact opaque ID for every later Worktree or Session operation.
- Save the returned `sessionId` and use that exact opaque ID for every later Session operation.
- Do not prompt, send keys to, stop, or otherwise change a pre-existing Worktree or Session unless the user explicitly directs that change.

Create an isolated Worktree with explicit Git inputs:

```sh
"$TESSERA_CLI_COMMAND" worktree create --current \
  -b "$new_branch" "$start_point" --json
```

If `--current` is unavailable, use `--project "$project_id"` with an exact observed Project ID. If preparation fails, preserve the returned resource information, stop the autonomous recipe, and report the structured error. Continue past preparation failure only when the user explicitly requests recovery.

## Launch and observe a Session

Choose an explicit provider ID; do not silently inherit the caller's provider. When the user explicitly chooses a Claude Code or Codex model or effort, pass it with `--model` and `--effort`; otherwise omit both options so the provider's own defaults remain in effect. For Codex, pass `--fast` or `--no-fast` only when the user explicitly chooses that service tier. Do not invent a model, effort, or service tier on the user's behalf. For a multiline initial prompt, prefer stdin so shell quoting cannot alter the content:

```sh
"$TESSERA_CLI_COMMAND" session launch \
  --worktree "$worktree_id" \
  --provider "$provider_id" \
  --model "$model_id" \
  --effort "$effort" \
  --prompt-file - \
  --json <<'TESSERA_PROMPT'
<initial instructions>
TESSERA_PROMPT
```

When the user explicitly selects a Codex service tier, add exactly one of `--fast` or `--no-fast` to that command.

The same `--model`, `--effort`, `--fast`, and `--no-fast` options are accepted by `session create`; the stored selection is applied later by `session start` and reapplied when the provider conversation resumes. Model and effort selection currently apply only to `claude-code` and `codex`. Fast selection applies only to `codex`; `--no-fast` is an explicit opt-out and is not equivalent to omitting both flags.

Use `--no-prompt` only when an intentionally empty interactive Session is required. Use `--allow-preparation-failure` only for the explicit recovery case described above.

Wait for an observable lifecycle boundary and then read the current screen:

```sh
"$TESSERA_CLI_COMMAND" session wait "$session_id" \
  --for turn-complete --json
"$TESSERA_CLI_COMMAND" session read "$session_id" --json
```

`turn-complete` means only that the provider ended its current response. It is not proof that the requested work succeeded. Inspect the returned output and the Worktree repository state, including relevant diffs and verification results, before deciding what to report or whether another prompt is needed.

Send follow-up text through the Session prompt operation, preferably from stdin when multiline:

```sh
"$TESSERA_CLI_COMMAND" session prompt "$session_id" --file - --json <<'TESSERA_PROMPT'
<follow-up instructions>
TESSERA_PROMPT
```

Use `session send-keys` only after `session read` or `session wait` shows a specific input or permission boundary. A visible permission prompt is not authorization: obtain user approval before sending a key that grants authority beyond the user's existing request. Send only documented named keys such as `enter`, `escape`, or `ctrl-c`; never use it as a general terminal-input channel.

Stop a live runtime only when the user requests it or the user-approved operation requires cancellation:

```sh
"$TESSERA_CLI_COMMAND" session stop "$session_id" --json
```

After any non-zero response, read the structured error code and details, consult version-matched help if needed, and avoid speculative recovery that would change existing resources.

## Find and show a past Session

When the user is looking for an earlier conversation, search every Session they have, including chat Sessions, Sessions outside managed Worktrees, and archived ones:

```sh
"$TESSERA_CLI_COMMAND" session search conpty renderer --json
```

Every word must appear, case-insensitively, in the title, Project name, Worktree title, branch, Session ID, or provider session ID. Results are newest first; narrow them with `--current`, `--project "$project_id"`, `--active-only`, or `--limit` (1-100, default 20). `truncated: true` means more matched than were returned. An empty query lists the most recent Sessions.

Titles are short summaries, so a remembered detail often appears only in the conversation itself. Then search the provider transcripts on your own filesystem, for example with `rg -l` under `~/.claude/projects` for Claude Code or `~/.codex/sessions` and `~/.tessera/codex-overlay` for Codex. A transcript's file name carries its provider session ID; pass that ID to `session search` to find the Tessera Session. Each result's `transcriptPath` is where the CLI last reported its transcript, already in your path style; the file may have moved since, so fall back to the provider session ID when it is missing.

Present the likely matches to the user with title, Project, branch, and `updatedAt`, and let them choose. Do not open, prompt, or otherwise change a found Session on your own initiative.

When the user asks to see one, show it in their Tessera window:

```sh
"$TESSERA_CLI_COMMAND" session open "$session_id" --json
```

This behaves like the user selecting the Session in the sidebar: it switches to the Session's Project and tab in the desktop app, even when that window is behind other apps or minimized, and in any browser window that is currently visible. Success means at least one window showed it; if the user may be looking elsewhere, mention that it is open in Tessera. `UI_UNAVAILABLE` means no window took the request, for example because only a locked phone or a background browser tab is connected; tell the user instead of retrying.

## Rename a Session

When the user asks to rename a Session, pass its exact ID and the new title as one quoted argument:

```sh
"$TESSERA_CLI_COMMAND" session rename "$session_id" "ConPTY renderer root cause" --json
```

This is the same rename as the app's own: every Session that `session search` finds can be renamed, including chat and archived ones, and open windows update immediately. The title is trimmed and must be a single line of at most 100 characters. For a title that starts with `-`, end the command with `-- "$title"`. Rename only when the user asks; do not retitle Sessions on your own initiative.

## Archive a Session

Archive an exact Session ID when the user requests it or the authorized work includes retiring that Session:

```sh
"$TESSERA_CLI_COMMAND" session archive "$session_id" --json
```

Archive stops the Session's backing runtimes and preserves its conversation and Worktree, including when it is the Worktree's last Session. Siblings remain active. `session stop` only stops a runtime; it does not archive the Session.

An archived Session leaves the normal CLI list and cannot be shown, started, read, or prompted through that active Session interface. Repeating archive on the known ID is supported while its parent Worktree remains active; the existing app UI handles restore. A child of an archived Worktree cannot be archived independently.

Have the parent archive a worker after inspecting its result. Self-archive can terminate the invoking runtime before it receives the response. Never archive a pre-existing Session outside the user's authorized scope.

## Delete a Session

When the user requests deleting a Session, use its exact observed ID:

```sh
"$TESSERA_CLI_COMMAND" session delete "$session_id" --json
```

Delete stops the runtime and removes the Session and its conversation history using the
app's deletion lifecycle. The Worktree, its files, and sibling Sessions remain. An active
or individually archived Session can be deleted while its parent Worktree is active.
A deleted or unknown ID returns `SESSION_NOT_FOUND`; deletion cannot be undone.
Only delete existing Sessions within the user's explicitly authorized scope. Prefer having
the parent delete a worker: deleting the invoking Session can stop it before a response arrives.

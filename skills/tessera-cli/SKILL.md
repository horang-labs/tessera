---
name: tessera-cli
description: Operate Tessera-managed Projects, Worktrees, and Sessions through the injected version-matched control CLI. Use when an agent running inside Tessera needs to inspect its caller context, create an isolated Worktree, launch or observe a Session, send a follow-up at a known input boundary, or stop a live runtime.
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

Choose an explicit provider ID; do not silently inherit the caller's provider. For a multiline initial prompt, prefer stdin so shell quoting cannot alter the content:

```sh
"$TESSERA_CLI_COMMAND" session launch \
  --worktree "$worktree_id" \
  --provider "$provider_id" \
  --prompt-file - \
  --json <<'TESSERA_PROMPT'
<initial instructions>
TESSERA_PROMPT
```

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

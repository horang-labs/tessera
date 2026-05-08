# Claude Agent Teams And Codex Goals Planning

This document outlines a provider-native plan for bringing Claude Code Agent Teams and Codex goals into Tessera without weakening the provider adapter boundary.

## Current Signals

- Tessera already isolates CLI-specific behavior behind `CliProvider` adapters in `src/lib/cli/providers/`.
- Claude Code Agent Teams are experimental, disabled by default, and require Claude Code v2.1.32 or later. They coordinate multiple Claude Code sessions through a lead, teammates, a shared task list, and inter-agent messaging.
- Codex goals are experimental and disabled by default in upstream `openai/codex` at planning time. The app-server protocol exposes goal methods and notifications for `thread/goal/set`, `thread/goal/get`, `thread/goal/clear`, `thread/goal/updated`, and `thread/goal/cleared`.
- Tessera already starts Codex through `codex app-server`, stores provider state such as `threadId`, and sends `turn/start` requests through the Codex provider adapter.

## Product Goal

Expose long-running and multi-agent capabilities where they are native to each provider:

- Claude Code users can start and observe an Agent Team from Tessera while preserving the existing Claude Code session model.
- Codex users can set, pause, resume, clear, and observe a persistent goal on the active Codex thread.
- Existing Claude Code, Codex, and OpenCode workflows continue to behave exactly as they do today when these features are unavailable or disabled.

## Non-Goals

- Do not build a provider-agnostic orchestration engine in the first pass.
- Do not emulate Agent Teams or goals for providers that do not expose native support.
- Do not hardcode Claude or Codex protocol details in shared UI components.
- Do not replace Tessera tasks, collections, or worktree workflows with provider-owned task systems.

## Claude Code Agent Teams

Claude Code Agent Teams should start as a Claude-only capability surfaced through provider-specific session controls.

### Discovery

- Detect Claude Code version with the existing status/version probe.
- Treat Agent Teams as unavailable when the CLI version is below the documented minimum.
- Require explicit feature enablement through `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` before showing active controls.
- Prefer environment-based enablement from Tessera session startup over mutating the user's Claude Code settings file.

### Session Startup

- Extend Claude provider spawn options with a provider-specific `agentTeamsEnabled` flag.
- When enabled, add `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` to the spawned Claude process environment.
- Keep the current `--print --output-format stream-json --input-format stream-json` path unless CLI verification shows Agent Teams require an incompatible interactive mode.
- If Agent Teams cannot run in stream-json mode, gate the feature behind a separate implementation issue instead of partially exposing broken controls.

### UI Shape

- Add a Claude-only "Team" control near session mode/access controls when the feature is supported.
- Start with prompt-driven team creation instead of a full team designer. The user can ask Claude to create a team, and Tessera focuses on surfacing state.
- Show teammates as provider-owned child sessions or progress rows only after the stream protocol exposes stable identifiers.
- Make unsupported states explicit: disabled feature flag, old CLI version, unsupported terminal/display mode, or missing `tmux` when split panes are requested.

### State And Events

- Store any team identifier or lead/team metadata in `sessions.provider_state`.
- Preserve the existing Claude parser path for normal assistant, tool, and progress events.
- Add team-specific event parsing only after capturing real stream-json fixtures for team creation, teammate messages, task status updates, and cleanup.
- Do not assume Claude's local team files are a stable API. Treat `~/.claude/teams/` and `~/.claude/tasks/` as implementation details unless Anthropic documents them as integration points.

## Codex Goals

Codex goals should start as a Codex-only thread capability because Tessera already integrates with the Codex app-server protocol.

### Discovery

- Detect whether the Codex CLI supports goals by checking experimental feature metadata when available.
- Fall back to a harmless app-server probe for `thread/goal/get` after `thread/start` only when feature metadata is unavailable.
- If the server returns "goals feature is disabled", show an enablement hint instead of treating Codex as broken.

### Protocol Integration

- Add provider methods for Codex goal operations rather than sending raw JSON-RPC from UI code:
  - `thread/goal/set` with `threadId`, `objective`, optional `status`, and optional `tokenBudget`.
  - `thread/goal/get` with `threadId`.
  - `thread/goal/clear` with `threadId`.
- Track `thread/goal/updated` and `thread/goal/cleared` in the Codex protocol parser.
- Persist the latest goal snapshot in `sessions.provider_state` next to `threadId`.
- Keep status values aligned with upstream: `active`, `paused`, `budgetLimited`, and `complete`.

### UI Shape

- Add a Codex-only Goal panel for the active thread.
- Support the first practical controls: set objective, optional token budget, pause/resume, clear, and current status.
- Surface budget usage and elapsed time when Codex sends those fields.
- Keep the normal composer available. A goal is thread state, not a replacement for user turns.

## Shared Implementation Plan

1. Capture fixtures.
   - Claude: stream-json output for enabling Agent Teams, spawning teammates, teammate progress, team cleanup, and unsupported states.
   - Codex: app-server JSON-RPC for goal set/get/clear, update notifications, disabled feature errors, and resume behavior.
2. Extend provider-owned runtime options.
   - Add provider-specific fields to `SpawnOptions` or a nested provider options object.
   - Avoid expanding the shared contract with generic "team" or "goal" concepts until at least two providers expose compatible semantics.
3. Add provider actions.
   - Claude: environment-gated Agent Teams startup support first.
   - Codex: JSON-RPC goal action methods on the Codex adapter.
4. Parse and persist provider state.
   - Store team or goal metadata in `provider_state`.
   - Keep provider state additive so old sessions remain readable.
5. Add focused UI controls.
   - Claude-only Agent Teams availability and state surface.
   - Codex-only Goal panel.
6. Test provider boundaries.
   - Unit-test protocol parsing with captured fixtures.
   - Test unsupported and disabled states.
   - Smoke-test existing session creation for Claude Code, Codex, and OpenCode.

## Acceptance Criteria

- Existing sessions start, resume, send messages, and parse output unchanged when Agent Teams/goals are not enabled.
- Claude Agent Teams controls appear only for supported Claude Code versions with explicit experimental enablement.
- Codex Goal controls appear only when the app-server supports goal APIs or returns discoverable feature metadata.
- Provider-specific protocol details remain inside provider adapters and parsers.
- Goal/team metadata survives session reloads through `provider_state`.
- Unsupported states are visible and actionable rather than silent failures.

## Open Questions

- Does Claude Code Agent Teams work reliably in stream-json mode, or does it require an interactive terminal path?
- Which Claude team events are emitted through stream-json, and which only appear in terminal UI state?
- Should Tessera allow users to enable Claude Agent Teams per session, globally in settings, or both?
- What is the safest Codex feature-detection path for goals across stable and alpha releases?
- Should a Codex goal be set before the first user turn, after `thread/start`, or both?

## References

- Claude Code Agent Teams: https://code.claude.com/docs/en/agent-teams
- Claude Code subagents and teammate role reuse: https://code.claude.com/docs/en/sub-agents
- Codex goals feature flag: https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs
- Codex goal protocol types: https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs
- Codex goal request methods and notifications: https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/common.rs

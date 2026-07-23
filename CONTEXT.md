# Tessera Domain Context

## Glossary

### Agent execution mode

The interaction surface used when starting an agent session. A user chooses a preferred mode, while provider capabilities determine the effective mode. PTY is the default preference for new installations.

### PTY mode

The universal agent execution mode. Providers may be supported through their native terminal interface without requiring Tessera's structured chat integration.

### PTY session

A durable Tessera session record whose identity and resume metadata remain available after its terminal view or PTY runtime is closed.

_Avoid_: terminal tab, PTY process

### PTY preview

A temporary terminal view opened by a single session selection for inspection. A preview that starts a PTY runtime owns that runtime until the view is replaced, closed, or left for a retained tab, unless terminal input or an agent turn pins the view first.

_Avoid_: temporary session, preview session

### PTY runtime

The live terminal process tree backing a PTY session, including programs started from that terminal. Its lifetime is independent of both the visible terminal surface and whether an agent turn is in progress.

When a PTY runtime ends, its single-panel terminal tab closes while the durable PTY session remains available from the menu. A multi-panel tab is retained so unrelated panels are never discarded with the stopped runtime.

_Avoid_: running task, processing state

### PTY visible status

The menu status derived only from PTY lifecycle signals: an active agent turn shows a spinner, unread completion shows a yellow dot, and a live retained runtime shows a green dot with a stop action. User-input waiting is intentionally not represented until provider hooks can support it consistently.

_Avoid_: GUI turn status, terminal output heuristic

### PTY resume boundary

The point at which a stopped provider terminal can safely reopen by resuming its provider conversation. For Claude Code, opening the TUI and receiving `SessionStart` do not cross this boundary; the first submitted prompt does, because Tessera then has canonical session history.

_Avoid_: terminal launched, TUI started

### GUI mode

An optional structured-chat execution mode available only to GUI-capable providers. Claude Code, Codex, and OpenCode are currently GUI-capable. When GUI mode is preferred for a provider without that capability, the session uses PTY mode.

### Effective execution mode

The mode actually used by a session after applying the user's preferred execution mode to the selected provider's capabilities.

### Session execution mode

The effective execution mode fixed when a session is created. A session cannot switch between GUI and PTY modes, and conversation state cannot resume across those modes.

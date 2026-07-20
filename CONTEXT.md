# Tessera Domain Context

## Glossary

### Agent execution mode

The interaction surface used when starting an agent session. A user chooses a preferred mode, while provider capabilities determine the effective mode. PTY is the default preference for new installations.

### PTY mode

The universal agent execution mode. Providers may be supported through their native terminal interface without requiring Tessera's structured chat integration.

### GUI mode

An optional structured-chat execution mode available only to GUI-capable providers. Claude Code, Codex, and OpenCode are currently GUI-capable. When GUI mode is preferred for a provider without that capability, the session uses PTY mode.

### Effective execution mode

The mode actually used by a session after applying the user's preferred execution mode to the selected provider's capabilities.

### Session execution mode

The effective execution mode fixed when a session is created. A session cannot switch between GUI and PTY modes, and conversation state cannot resume across those modes.

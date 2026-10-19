# Codex CLI upgrade compatibility

Tessera owns the terminal lifecycle and creates a disposable `CODEX_HOME` for each
launch. Account history and authentication can be shared; daemon sockets and process
state cannot. Keep daemon state out of both overlay implementations and keep Codex
in the PTY-owned runtime mode for fresh and resumed sessions.

The 0.162.1 regression escaped mocked launch tests: Codex rejected the overlay's
`app-server-daemon` symlink and exited after Tessera had reported a successful spawn.
Testing argument construction alone cannot detect a provider's new startup behavior.

## Real CLI gate

Run `npm run test:codex-compat` with a Codex executable on PATH. Alternatively set
`CODEX_COMPAT_COMMAND` to one executable path, or set `CODEX_COMPAT_JS` to an isolated
npm installation's `@openai/codex/bin/codex.js` entry. The latter uses Node directly
and works on Windows without a `.cmd` shell wrapper.

The test uses production overlay and argument builders, a real PTY and Codex binary,
and a loopback Responses fixture. It creates an account fixture under `~/tmp`, never
loads real account credentials, and makes no paid model requests. It verifies:

- Startup with existing account daemon state, followed by an actual response.
- Shared, resumable session history after closing the first PTY.
- Overlay cleanup/recreation and a second response from the resumed conversation.
- SessionStart, UserPromptSubmit and Stop callbacks on both turns, including
  lossless delivery of a Korean workspace path.
- No private daemon state after closing the PTY, and preservation of account-owned
  daemon state during cleanup.

The native Windows check also caught a hook-shell mismatch: Codex can run hooks
through PowerShell, while the previous hook assumed cmd syntax. Native Codex now
decodes its observer script inside that PowerShell process, avoiding a nested
PowerShell startup and stdin forwarding boundary. This is the native Codex
PowerShell contract, not a cmd command. Claude hooks and WSL POSIX hooks retain their own shell contracts.

Failure is a nonzero exit. `.tmp/codex-compat/` contains terminal output, the last
screen and metadata including the exact CLI version even when a run fails. Set
`CODEX_COMPAT_EVIDENCE` to override the output directory. A stale success result is
removed before each run. The fixture disables marketplace plugins to avoid unrelated background downloads
and Windows file locks. It does not execute tools, test plugin installation, or
test real authentication.

## Automation

`codex-compat.yml` tests the known baseline (0.162.1) and npm `latest` on Linux and
native Windows. It runs on relevant pull requests, manual dispatch, and daily on the
default branch so upstream changes can be detected without a Tessera source change.
Failures retain evidence in Actions artifacts. This workflow must be merged to the
default branch before the schedule becomes active; it does not pin or update users'
Codex installations.

Desktop build workflows and new npm publication require this gate to succeed.
Desktop checks use the requested build tag/ref. Re-publishing already-built desktop
artifacts and changing an existing npm dist-tag retain their existing workflows.
A green result covers the exact recorded CLI versions, not future updates.

This gate is native CLI compatibility evidence, **not** a Windows-backend + WSL-CLI
end-to-end test. For changes at that bridge, also follow `tessera-electron-dev` and
exercise CLI creation, response, stop and resume in an isolated packaged app. Keep
screenshots of the actual renderer. The original 0.162.1 fix was verified that way.

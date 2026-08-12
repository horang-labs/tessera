# Electron test launch environment isolation

The checked-in Windows launcher is the fail-closed boundary between an agent
shell and every isolated packaged Electron child. Before each `Start-Process`,
`scripts/launch-electron-test-instances.ps1` snapshots and removes inherited
agent-runtime state. Its `finally` block restores every saved process value after
both successful and failed launches.

Within Tessera and agent-provider namespaces, a child receives only the values
the launcher assigns explicitly:

- `TESSERA_ELECTRON_TEST_INSTANCE`
- `TESSERA_ELECTRON_TEST_ROOT`
- `TESSERA_ELECTRON_TEST_SERVER_PORT`
- `WSL_DISTRO_NAME`

The launcher removes every other inherited `TESSERA_*` variable, including
pane/session/hook credentials, project/worktree context, CLI/control bridge
state, agent environment, and provider resume state. It also removes every
`CODEX_*`, `CLAUDE_*`, and `OPENCODE_*` variable plus `CLAUDECODE`. Prefix
matching is intentional so future session or overlay variables fail closed.

`XDG_DATA_HOME` is removed separately because OpenCode can use it as a data-home
override without a provider prefix. `WSLENV` is also removed so caller-specific
forwarding and POSIX path-conversion instructions cannot be replayed across the
packaged Windows-to-WSL hop. The existing Electron boundary variables
`ELECTRON_RUN_AS_NODE`, `ELECTRON_CHILD`, and `NODE_ENV` remain cleared as well.

This is an agent-runtime boundary, not a blank process environment. Windows
system variables required to start the executable remain intact. Unrelated API
credentials such as `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are not agent
session overlays and are outside this contract.

Behavior coverage uses
`tests/fixtures/electron-launch-environment-harness.ps1`. It replaces process
and CDP boundaries without starting Electron, captures two successive child
environments under hostile inherited POSIX overlays, and verifies exact parent
restoration. A separate synthetic `Start-Process` failure proves restoration on
the exception path.

Do not weaken the independent ownership contract while changing environment
isolation: session manifests, per-launch owner tokens, bind-probed ports,
serialized allocation, test-only singleton bypass, and exact cleanup validation
remain mandatory.

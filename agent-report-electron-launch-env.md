# Issue #352 — isolated Electron launch environment report

Fixed point: `7adffb9a688e1e9b6b5a26dafdb0282e99ffdd8d`

Implementation checkpoint: `26c5fcd` (`fix(electron): sanitize isolated launch environment`)

## Diagnosis and boundary

The real failure was reproduced at the Windows child-process boundary without
starting Electron. A PowerShell harness invoked the checked-in launcher with a
mocked `Start-Process`, captured the environment that the child would receive,
and initially observed:

```text
CODEX_HOME leaked into launch 1
actual: /home/work/.tessera/codex-overlay/session-hostile
expected: null
```

The launcher had a fixed list of Electron/server variables. It did not remove
the caller's agent runtime, so Windows Electron and its server child inherited a
WSL-session Codex home and Tessera control credentials. Clearing only
`CODEX_HOME` and `TESSERA_CODEX_HOME` would leave the same class of defect open
through pane/session variables, OpenCode/Claude homes, future injected names,
and `WSLENV` forwarding instructions.

The implemented boundary snapshots all values it owns, sanitizes before every
child launch, and restores them in `finally`:

- keep and explicitly assign only `TESSERA_ELECTRON_TEST_INSTANCE`,
  `TESSERA_ELECTRON_TEST_ROOT`, `TESSERA_ELECTRON_TEST_SERVER_PORT`, and
  `WSL_DISTRO_NAME` within the agent-runtime namespace;
- clear every other inherited `TESSERA_*` variable;
- clear every inherited `CODEX_*`, `CLAUDE_*`, and `OPENCODE_*` variable plus
  `CLAUDECODE`;
- clear `XDG_DATA_HOME`, the non-prefixed OpenCode data-home override;
- clear `WSLENV`, preventing caller forwarding/path-conversion instructions
  from crossing back into the packaged Windows-to-WSL hop; and
- retain the existing removal of `ELECTRON_RUN_AS_NODE`, `ELECTRON_CHILD`, and
  `NODE_ENV`.

This is an agent-runtime boundary, not a blank Windows environment. System
variables required to start the executable and unrelated API credentials remain
intact. The repository contract is documented in
`docs/agents/electron-test-isolation.md`.

No ownership logic changed. Manifest schema/ownership tokens, exact executable
and PID recording, serialized bind-probed port allocation, the validated
test-only singleton bypass, and normal application single-instance behavior are
unchanged.

## RED/GREEN evidence

Public seams:

- child environment observed at the launch process boundary;
- parent process environment observed after launcher return/throw; and
- existing Electron test-instance APIs for normal singleton and server-port
  behavior.

The first harness attempt exposed a test-scope accumulation defect and was
discarded. After correcting the harness itself, the valid RED command was:

```sh
node --test tests/electron-test-launcher-contract.test.mjs
```

- Primary RED: 4 tests, 3 pass, 1 fail; `CODEX_HOME` retained the hostile POSIX
  overlay shown above.
- Transport RED: after adding hostile `WSLENV`, both success and failure cases
  failed because `CODEX_HOME/p:TESSERA_CODEX_HOME/p:TESSERA_PANE_TOKEN` crossed
  the boundary.
- Provider-home RED: after adding hostile `XDG_DATA_HOME`, both cases failed
  with `/home/work/.local/share/session-hostile` in the would-be child.
- Final GREEN: 6/6. Two successive launches contained none of the hostile
  Codex/Claude/OpenCode overlays, Tessera pane/session/hook/project/worktree/CLI/
  control data, future-prefixed secrets, `WSLENV`, or `XDG_DATA_HOME`. The
  launcher restored all original values after success and after a synthetic
  `Start-Process` exception.

The harness replaces only process and CDP boundaries. It does not start or stop
an Electron process.

## Validation

| Check | Result |
| --- | --- |
| Focused launcher/model/quit contracts | 11/11 pass; 0 fail/skip/cancelled |
| Electron test-instance behavior | 6/6 pass; normal singleton and explicit test port preserved |
| Full natural-exit unit suite | 1,630 total; 1,628 pass; 0 fail/cancelled; 2 existing platform skips; no force-exit |
| Full natural-exit contract suite | 357/357 pass; 0 fail/skip/cancelled; no force-exit |
| `npx tsc --noEmit` | exit 0; no diagnostics |
| `npm run lint` | exit 0; 0 errors; 3 pre-existing warnings outside this diff |
| PowerShell parser | launcher and behavior harness parse successfully under Windows PowerShell 5.1 |
| Bash wrapper syntax | `bash -n .codex/skills/tessera-electron-dev/scripts/build_and_launch.sh` exit 0 |
| `npm run electron:prebuild` | exit 0; production Next build, Electron compile, and 8,034-file runtime preparation completed |
| `graphify update .` | exit 0; final refresh 11,011 nodes, 28,929 edges, 435 communities |
| `git diff --check` | exit 0 |

The initial natural-exit attempt exited 127 before running tests because the
isolated worktree had no local dependencies. `npm ci` installed exactly from
`package-lock.json`; both suites were then run without `--test-force-exit`.

## Two-axis code review

`code-review` ran Standards and Spec agents in parallel against
`git diff 7adffb9...HEAD`.

### Standards

No hard documented-standard violations. Two judgement-call findings were
resolved:

1. The test checked the absolute Windows PowerShell path but spawned bare
   `powershell.exe`, which could fail when WSL PATH import is disabled. It now
   executes the same verified absolute path.
2. Success and failure tests duplicated the hostile-environment assertion. They
   now share `assertHostileEnvironmentCleared`.

### Spec

No committed implementation defect or scope creep was found. The reviewer
identified the report/validation evidence as pending and correctly classified
the live packaged terminal-close outcome as unverified under the explicit
no-live-Electron constraint. This report closes the durable evidence item
without upgrading deterministic boundary evidence into an end-to-end claim.

First review totals: Standards 2 findings (both resolved); Spec 0 implementation
findings, with 3 pending evidence/exclusion notes addressed here.

## Deliberate exclusions

- No Electron executable was launched or stopped. Therefore this work does not
  claim a live standalone packaged terminal close was observed. It proves the
  causal boundary that prevents caller-sourced `C:\home\...` overlay paths; the
  root orchestrator owns live packaged QA.
- No portable installer was built. `electron:prebuild` validated the production
  web build, Electron TypeScript, and runtime staging only.
- No GitHub issue, label, comment, pull request, or remote branch was mutated;
  nothing was pushed.
- No live listener owner was terminated. The behavior harness used test doubles
  for process/CDP ownership and allowed the launcher only to bind-probe/release
  candidate ports.
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and unrelated system variables are not
  Tessera agent-session overlays and were deliberately not added to the clear
  boundary.
- The three lint warnings are pre-existing and occur in
  `preview-markdown.tsx`, `use-virtual-message-list.ts`, and
  `spawn-cli-runtime.ts`; none is part of this diff.

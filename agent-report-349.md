# Agent report — issue #349

## Scope

Completed the final packaged Windows-to-WSL acceptance ticket for spec #338 from fixed baseline
`840c79f2d04453bd7a54cb841592ea16ad29f20e`.

- Fixed WSL legacy Codex overlay creation, cleanup, repair, and rollout observation to resolve the
  login-shell Authoritative Provider Home instead of assuming `$HOME/.codex`.
- Made the exported Provider Integration singleton process-global so the packaged WebSocket
  terminal host and Next route projections share live Managed Session health across bundle
  boundaries.
- Hardened isolated Electron launcher/restart/cleanup ownership, environment scrubbing, WSL
  fixture/state ownership, PowerShell 5.1 native-argument handling, and exact 33-byte GUID-N
  ownership markers.
- Added a durable, synthetic, secret-free packaged Windows Electron/Windows backend/WSL agent
  fixture and runner covering every #349 acceptance seam through the real renderer and terminal
  WebSocket path.

## Commits

- `1bf7c70` — `test: complete packaged Windows-to-WSL acceptance`
- This report is committed separately from the product/test change, as requested.

No commit was pushed or merged, and no GitHub issue, PR, label, or comment was changed.

## Packaged acceptance evidence

Final run:

```text
sessionId: t349-final17-0812-1720
topology: windows-electron/windows-backend/wsl-agent
serverPort: 32124
TESSERA_DEV_PORT: unset
artifactSha256: ef94890130d94c27f127008c9e855222417ac711d0ddeae821409a5a3f1cd05b
launchExecutableSha256: 754aefd95a95bcbb512dd1a39e3e2ded66cb9d67e784c5bfa892c83778f791a4
assertionsPassed: true
cleanupComplete: true
```

The runner built a portable Windows artifact plus an unpacked Windows application, launched the
unpacked `Tessera.exe`, verified the renderer reported `win32` with a WSL Agent Environment, and
used the packaged Windows server child. It did not substitute a WSL development server.

### Acceptance seams exercised

- **Login-shell custom WSL `CODEX_HOME`:** isolated `zsh -ilc` selected the synthetic custom
  Codex home; the managed Codex PTY used that exact home.
- **Durable Codex-owned state:** synthetic configuration, MCP state, authentication fixture,
  history, and lifecycle transitions remained consistent across Session and whole-app restart.
  Fixtures contain no real credentials.
- **Hook coexistence and external no-op:** a pre-existing synthetic user hook continued to run;
  the Tessera hook coexisted with it; an external Codex invocation recorded `managed: false` and
  did not invoke Tessera control.
- **Fail-closed degraded/unavailable hook policy:** an existing Managed Session remained usable
  and projected `integrationHealth: degraded`; its project-scoped control bridge continued to
  work; a new Codex launch failed closed while lifecycle inspection reported unavailable.
- **Optional provider skills:** Claude Code, Codex, and OpenCode skills were installed only below
  the isolated WSL provider homes (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and
  `XDG_CONFIG_HOME/opencode`); removing them did not block provider launch; reinstall succeeded.
- **Legacy overlay compatibility:** an exact recorded legacy overlay Session resumed from its
  matching WSL overlay, while new and derived Sessions used the login-shell Authoritative
  Provider Home.
- **Project-scoped control and audit:** `status` matched the injected Project,
  `worktree list --current` succeeded, an unauthorized Worktree mutation failed with
  `CONTROL_AUTHORITY_DENIED`, a foreign Project audit was denied, and Project audit returned only
  the approved metadata fields (`projectId`, `sourceSessionId`, `operation`, `target`,
  `occurredAt`, `outcome`, and optional `failureCode`).
- **Honest artifact removal:** an externally modified Tessera-owned skill produced a conflict and
  incomplete-removal result without overwrite; restoring the exact owned fixture allowed complete
  removal. The user hook remained and all Tessera lifecycle/skill artifacts were absent.
- **Launcher ownership:** exact owner restart succeeded, while another GUID-N owner, a shell
  expression, a multiline marker, and a GUID followed by an unterminated tail all failed closed.

## Installed-app and data preservation

Before and after the final packaged run, the installed application remained:

```text
Electron parent PID: 47576
packaged server PID: 23324
installed server port: 32123
listeners: 127.0.0.1:32123 and 100.103.66.17:32123, both PID 23324
```

The following pre/post SHA-256 values were identical:

```text
fabdf9c2e088193b3aa64bf64c5cda1e1559f1ee5279c7a0958550ed78017b31  ~/.tessera/tessera-dev.db
8095eae016a1675fc896f2d95477865f6d7c00b8dff6221f1302847bad58a54c  ~/.tessera/tessera.db
fa76d05652f6efe19e67f49f8c2e787a67b6824c71795faa900cb36eb8559e7c  ~/.codex/auth.json
b72421525b0655671faa8052da881f719080d7de5363ec96d1b823a6e51ba0ae  ~/.codex/config.toml
fc9718578be4428a7ffb479ba033f3166c7b7794d183a323fee8b81ca34b189b  ~/.codex/hooks.json
50d84da876354bd6a3fd0ea6bbc2c3917823d05ef18d52c8d46ede19c8f08395  ~/.claude/.credentials.json
ffbb1139574aa389df59bfa8b6f17d2f7fd541bcd7579fc9172583016381cc8b  ~/.claude/settings.json
13152cc5504ba142d4a8f9a891d3060834d43f926f07b31b9f3ab6970c82d64c  ~/.local/share/opencode/auth.json
```

No real secret value was copied into a fixture, log, screenshot, report, or commit.

During a pre-final acceptance attempt, missing `XDG_CONFIG_HOME` isolation briefly placed one
Tessera-owned synthetic test skill at `~/.config/opencode/skills/tessera-cli`. Its ownership marker
and creation time identified the exact test artifact; it was moved recoverably to trash with
`gio trash`. The launcher now scrubs and replaces `XDG_CONFIG_HOME`, the runner compares real WSL
skill trees before/after, and the final state confirms all three real WSL skill locations are
absent. No auth/config file hash changed.

## Cleanup evidence

The final runner stopped only processes named in its launcher ownership manifest and verified:

- test port 32124 is closed;
- the installed PIDs and port 32123 are unchanged;
- the exact Windows test root and session manifest are absent;
- launcher-owned WSL fixture and per-instance state roots are absent;
- copied Windows data is absent;
- portable and unpacked Downloads artifacts are absent;
- the unique package output directory is absent;
- all real provider-home hashes and skill-tree snapshots equal their pre-run values.

All failed pre-final runs also exited through the ownership-checked cleanup trap. No unowned
artifact was deleted and the installed Tessera process was never stopped.

## Test and build evidence

Focused acceptance and regression validation:

```text
TypeScript focused tests: 71 passed, 0 failed
Electron launcher contracts: 8 passed, 0 failed
Targeted terminal login-shell contract: 1 passed, 0 failed
Focused total: 80 passed, 0 failed
Packaged final acceptance: 1 passed, 0 failed
```

Static/build gates:

- `git diff --check` — pass
- `npx tsc --noEmit` — pass
- `npm run lint` — pass with 0 errors and the same 3 baseline warnings
- `npm run electron:compile` — pass
- `bash -n` / `node --check` / Python fixture compilation — pass
- `graphify update .` after final changes — pass; 11,311 nodes / 29,510 edges. It emitted the
  existing zero-node warning for `provider-skill-ids.json`.

Repository-wide suites:

```text
TypeScript: 1670 total, 1662 passed, 6 failed, 2 skipped
MJS:         358 total,  345 passed, 13 failed, 0 skipped
Combined:   2028 total, 2007 passed, 19 failed, 2 skipped
```

The 19 unchanged baseline failures are unrelated to #349:

1. `active workspace session resolves workspace special tabs to their source session`
2. `a huge diff is capped before it reaches the prompt`
3. `migrated checkout consumers cannot reintroduce direct child-first SQL`
4. `the bar offers exactly the five decided keys, in the decided order`
5. `each bar key sends the byte sequence a keyboard would`
6. `workspace file drags carry both panel and composer payloads`
7. `tests/agent-execution-mode-picker.test.mjs`
8. `tests/font-scale-and-status-indicator-contract.test.mjs`
9. `deferred session creation stays pre-start until the provider starts`
10. `every user-facing New Tab command reuses an existing pristine empty tab`
11. `the narrow project rail scrolls without reserving visible scrollbar space`
12. `single-panel terminal sessions omit only the redundant session header`
13. `resume, delete, archive, restore, and worktree cleanup hold atomic handoff exclusion`
14. `server filesystem reads resolve WSL POSIX paths before calling node fs`
15. `terminal panels without a bound session do not inherit stale active session cwd`
16. `terminal panels preserve the source session context used to create them`
17. `terminal panels can be pulled into a new tab from a multi-panel layout`
18. `OpenCode WSL sessions prepare a guest-native shared overlay`
19. `workspace folder rows expose the Electron open path context menu`

## Code review

The `$code-review` workflow ran Standards and Spec reviewers against fixed point
`840c79f2d04453bd7a54cb841592ea16ad29f20e`.

Actionable Standards findings were resolved:

- unquoted shell ownership comparisons could interpret a tampered marker as an expression;
- newline counting alone accepted a valid GUID first line followed by an unterminated tail.

The final code requires the PowerShell token to be GUID-N, then requires the WSL marker to be
exactly 33 bytes, exactly one newline, exactly 32 hexadecimal characters, and exactly equal to
the token before restart or cleanup. Executable regression tests cover every reported case, and
the packaged final17 run exercised successful launch/restart/cleanup with this code.

Final review results at `1bf7c70`:

- Standards: clean; no actionable findings.
- Spec: clean; no actionable findings and all #349/#338 acceptance criteria covered.


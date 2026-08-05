# Ticket 11: packaged Windows-to-WSL topology record

Tested on 2026-08-05 (Asia/Seoul) with the repository's isolated Electron procedure. Authentication tokens and the launcher ownership token are intentionally omitted.

## Isolation and process ownership

- Source branch/worktree: `feature/0803-zo` at `3b07c569b347711c97148296ff1b523ddb463584`.
- Packaged artifact: `C:\Users\work\Downloads\Tessera-0.2.3-hotfix.1-feature-0803-zo-electron-dev-20260805-145747.exe`, SHA-256 `f7885c0508e7d1e096c0c14935faee89f089e34e9bc2b15b78c185c1ecc5002c`.
- Launched unpacked executable: `C:\Users\work\Downloads\Tessera-0.2.3-hotfix.1-feature-0803-zo-electron-dev-20260805-145747-unpacked\Tessera.exe`, SHA-256 `c2c7f6828eecef4496279cb5eab5f1fc7aea7253283756e8c2fbac9e6687537e`.
- Isolated launcher identity: `codex-t11-0805d`; instance/data/user-data roots were siblings below `C:\Users\work\AppData\Local\TesseraTestInstances\codex-t11-0805d`.
- `TESSERA_DEV_PORT` was unset. Windows Electron PID `42240` owned CDP `127.0.0.1:9337`; its packaged Windows server child PID `20380` owned `127.0.0.1:32124` and served `http://localhost:32124/chat`.
- The installed app remained responsive as Windows PID `24992` on `127.0.0.1:32123` throughout. The test used neither that process nor that port.
- The descriptor-selected control runtime was `c7cf883a-0358-4332-95b7-beceaa650575`, `connected`, at origin `http://127.0.0.1:61954`; its server PID was the packaged Windows server PID `20380`.
- The copied settings selected WSL. The caller provider ran inside `Ubuntu-24.04` as Linux PID `1698570`; the UI-attached child provider was observed as Linux PID `1969728` (`codex resume ...`). The Windows packaged server owned the PTY broker; the provider process and checkout lived in WSL.

The caller-visible Project was `/home/work/.tessera/worktrees_from_elec/tessera-dev/feature/0803-zo`; its Windows-host view was `\\wsl.localhost\Ubuntu-24.04\home\work\.tessera\worktrees_from_elec\tessera-dev\feature\0803-zo`.

## Injected bridge and autonomous caller

The real caller read the bundled `tessera-cli` skill, then used only its quoted injected bridge. The guest executable was mode `0700` at `/run/user/1000/tessera/control-bridges/bridge.xLOITs/tessera`. It:

1. preserved the WSL working directory;
2. encoded all CLI arguments as a mode-`0600`, NUL-delimited UTF-8 file;
3. spooled `--prompt-file -`/`--file -` stdin to a mode-`0600` WSL file and converted both paths with `wslpath -w`;
4. invoked the runtime-specific Windows PowerShell bridge, which invoked the packaged `Tessera.exe` CLI with the exact descriptor and caller context.

`status --json` returned the runtime above and this caller context:

- Project: `/home/work/.tessera/worktrees_from_elec/tessera-dev/feature/0803-zo`
- caller Worktree: `wt_e507ec9a29124071a377f924c06ffaca`, branch `t11-caller-0805d`
- caller Session: `5cfbce60-fd6a-4fcf-b72f-fadeaa8f7148`
- caller terminal: `session-5cfbce60-fd6a-4fcf-b72f-fadeaa8f7148`

The caller then created and operated:

- child Worktree: `wt_facab5dacbea4bf681db0f850812c7ec`
- branch/start point: `t11-child-0805d` / `HEAD`
- WSL checkout: `/home/work/.tessera/worktrees/0803-zo/t11-child-0805d`
- Windows-host checkout: `\\wsl.localhost\Ubuntu-24.04\home\work\.tessera\worktrees\0803-zo\t11-child-0805d`
- child Session: `c34ff914-bbe0-4c84-ba1d-2d94e3376c14`
- child terminal: `session-c34ff914-bbe0-4c84-ba1d-2d94e3376c14`

`session launch --prompt-file -`, `session wait --for turn-complete`, and `session read` all succeeded. The first lifecycle preview and exact screen output were `T11-SECOND-0805D` at output sequence `76`.

## UI attachment and follow-up lifecycle

The isolated Electron renderer selected Project `0803-zo` and displayed both `T11 caller 0805D` and `T11 child 0805D`. Opening the child produced a CDP-observed `terminal_create` request containing the exact child Session and terminal IDs above. The packaged server answered with `terminal_started`, `terminal_snapshot`, and `terminal_output` for that same terminal ID; the rendered screen contained the earlier `T11-SECOND-0805D` turn and the child branch `t11-child-0805d`.

The actual Electron xterm then submitted this multiline follow-up:

```text
Ticket 11 multiline follow-up, line one.
Ticket 11 multiline follow-up, line two.
Reply with exactly T11-FOLLOWUP-0805D
```

The same terminal moved through:

- `running`: state time `1785911221987`, output sequence `157`
- `turn-complete`: state time `1785911223595`, output sequence `177`, lifecycle preview and exact output `T11-FOLLOWUP-0805D`
- `exited` after the exact `session stop`: state time `1785911457853`, still terminal `session-c34ff914-bbe0-4c84-ba1d-2d94e3376c14`

After exit, `session show` and `session list --worktree wt_facab5dacbea4bf681db0f850812c7ec` still returned the durable child Session, and the stopped `T11 child 0805D` card remained visible in the isolated UI.

## Defects found and regression coverage

The packaged topology exposed three narrow boundary defects, each reproduced before its fix:

- The isolated launcher accepted no dedicated packaged-server port and failed on `-ServerBasePort`. The launcher now assigns and verifies `TESSERA_ELECTRON_TEST_SERVER_PORT`; normal Electron ignores that variable.
- Raw WSL stdin for `--prompt-file -` was lost at the PowerShell boundary. The guest bridge now securely spools and path-translates stdin.
- PowerShell consumed forwarded options such as `--for`, and a GUI-subsystem `Tessera.exe` error could appear as exit `0`. The bridge now forwards an opaque NUL-delimited argv file, uses strict UTF-8, waits through an output pipeline, and propagates the real exit code.

Focused verification passed: 14 TypeScript bridge/instance tests (including a real `wscript.exe` GUI-subsystem exit-code boundary), 7 launcher/UI contract tests, targeted ESLint for every changed TypeScript/JavaScript file, `npx tsc --noEmit`, and `npm run electron:compile`.

The one repository-wide `npx tsx --test tests/*.test.ts tests/*.test.mjs` run emitted no failure and passed through test 259, but did not reach a TAP summary: four pre-existing server test workers (`control-session-controller`, `control-session-observer`, `preparation-claim-timing`, and `ws-session-access-guard`) retained open Node handles for five minutes, so the run was interrupted rather than repeated.

## Data integrity and cleanup

- Source `tessera-dev.db` SHA-256 before/after: `6c54fd400d427846d0528460bca9c5a082c5039bd21be458a63b73345d440343`.
- Source `tessera.db` SHA-256 before/after: `8095eae016a1675fc896f2d95477865f6d7c00b8dff6221f1302847bad58a54c`.
- The seed copy initially matched `tessera-dev.db`; only the isolated copy changed while the test created its records.
- Cleanup ran `stop-electron-test-session.ps1 -SessionId codex-t11-0805d -RemoveData`. It validated the ownership manifest, stopped recorded PID `42240`, removed the manifest and isolated data, and left PID `24992`/port `32123` live.
- Ports `32124` and `9337` were closed. The exact portable/unpacked copies, both clean test Worktrees, and branches `t11-caller-0805d`/`t11-child-0805d` were removed. No image-name, broad-path, or port-based termination was used.

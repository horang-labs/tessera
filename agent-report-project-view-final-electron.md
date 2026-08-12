# Issue #328 — final integrated Project View and packaged Electron QA

Integration branch: `feature/0811-dx`

Integrated implementation HEAD before this report: `b815cad0` (`Merge feature/0812-t352: isolate Electron launch environment`)

This report covers the dependency wave for issues #329–#337 and the three defects found by integrated QA (#350–#352). Every child issue is closed and its implementation branch is published. The integration branch remains local by orchestration policy.

## Integrated validation

| Check | Result |
| --- | --- |
| Project View state matrix | 140/140 pass |
| Project View contracts | 38/38 pass |
| `npm run test:non-e2e` TS/TSX | 1,632 total; 1,630 pass; 0 fail/cancelled; 2 platform skips |
| `npm run test:non-e2e` MJS | 357/357 pass; 0 fail/cancelled/skipped |
| `npx tsc --noEmit` | exit 0; no diagnostics |
| `npm run lint` | exit 0; 0 errors; 3 pre-existing warnings outside this wave |
| production build | exit 0 |
| `graphify update .` | exit 0; 11,029 nodes, 28,953 edges, 435 communities |

The full non-E2E suites exited naturally. Their deliberate failure-path log messages are asserted test fixtures, not suite failures.

## Isolated packaged Windows topology

The final executable was built from the integration worktree with debug logging enabled and launched through the repository's fail-closed isolated Electron launcher:

- portable executable: `C:\Users\work\Downloads\Tessera-0.2.3-hotfix.1-feature-0811-dx-final-electron-debug-20260812-153544.exe`
- SHA-256: `60c3166d13987024a0fa344c3ec1890525f83d4167e8afa985e1658e7bfcf346`
- isolated session: `codex328-0812-final153544`
- Windows Electron PID: `51780`
- packaged Windows server PID: `31660`
- app/CDP ports: `32126` / `9357`
- isolated DB: `C:\Users\work\AppData\Local\TesseraTestInstances\codex328-0812-final153544\data\tessera.db`
- renderer: Electron page `http://localhost:32126/chat`, reached and inspected through CDP
- agent topology: Windows packaged server and Electron renderer, WSL `Ubuntu-24.04` Git/CLI/worktrees

Inspection of `app.asar` confirmed `tesseraLogLevel: debug`. The package did not use `TESSERA_DEV_PORT`; the server under test was the packaged Windows child, not a Linux development server behind a Windows-looking renderer.

## Packaged acceptance results

The acceptance fixture used one canonical linked Session projected through its origin Project and linked Worktree. Assertions exercised public UI actions and real HTTP/WebSocket state:

- linked Session opened from the Project view in Peek and a normal tab;
- Git/Files resolved to the linked Worktree rather than the origin Project;
- unread completion rendered the same yellow (`rgb(250, 204, 21)`) in the inactive tab and Project sidebar;
- activating the Session cleared canonical unread state;
- Worktree density transitioned composite → standalone → composite across Session archive/restore;
- archive was invoked from the real panel context menu, left the zero-Session Worktree selectable, restored successfully, and never showed `Session not found`;
- a second Electron window observed source-window Task/workflow/title changes and converged to the same state while the source Project selection remained stable;
- All/Running filters toggled their `aria-pressed` state correctly; `Running 1` rendered exactly one live item, and the test restored All;
- the shared New Tab command reused the current pristine tab on a second invocation;
- the packaged server spawned `wsl.exe` at the exact fixture path, accepted keyboard input through xterm, and returned `__TESSERA_PACKAGED_WSL_PTY_OK__` to the renderer;
- UI terminal close produced `terminal_exit` with `exitCode: 0` and returned the panel to New Tab.

Screenshots and isolated debug logs are retained under `.tmp/electron-qa-328-final153544/evidence/`. Key images are `unread-tab-sidebar-packaged.png`, `linked-session-peek-packaged.png`, `linked-session-tab-packaged.png`, `zero-session-worktree-packaged.png`, `issue-332-source.png`, `issue-332-receiver.png`, `packaged-terminal-new-tab.png`, and `sidebar-all-running-packaged.png`.

## Log and isolation audit

The final debug log contained:

- 0 `C:\home\work\.tessera\codex-overlay` path leaks;
- 0 `ENOENT`;
- 0 raw RSC markers (`self.__next_f` / `text/x-component`);
- 0 actual HTTP 404 responses;
- 0 `Session not found`;
- 0 forbidden matches in the terminal-close delta.

Three renderer `Failed to fetch` entries occurred exactly while the QA harness disconnected/reloaded a renderer. In each case the log immediately records WebSocket reconnect and successful server responses; no server crash or user-visible failure survived the reconnect. Debug-level Git fetch failures are expected because the deliberately minimal fixture has no `origin` remote.

Isolation was checked before and after cleanup:

- the installed app remained PID `47576`, installed server PID `23324`, listening on port `32123`;
- the source database SHA-256 remained `fabdf9c2e088193b3aa64bf64c5cda1e1559f1ee5279c7a0958550ed78017b31`;
- only test PIDs `51780`/`31660` and ports `32126`/`9357` disappeared;
- the exact isolated data root was removed through the ownership manifest;
- all 15 fixture-linked worktrees and their exact fixture branches were removed; the fixture main worktree remains;
- the final portable executable was retained; duplicate unpacked/build copies were permanently removed to reclaim approximately 1.58 GB.

## Ticket wave result

Closed and published: #329, #330, #331, #332, #333, #334, #335, #336, #337, #350, #351, and #352.

The two QA-discovered product defects were fixed before final acceptance:

1. #351 prevents passive Project/Task reloads from rerunning startup fallback and hijacking deliberate board-only navigation.
2. #352 removes inherited Tessera/agent/session overlay variables at the isolated Electron launch boundary and restores the parent environment on success or failure.

No integration-branch push or pull request was created by this report.

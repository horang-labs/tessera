# Issue #350 — full-suite QA report

Fixed point: `e7b330361d128c97ce1b01c172142ee39d4681b1`

Implementation commits reviewed by this report:

- `ed7bf07c1761c7d3aee580239e1683c8770e0987` — stabilize the non-E2E suite, replace drifted coverage, and remove the original lifetime leaks.
- `2767ddb569a8f37ef03ff9f0ea18863fbbba7c16` — resolve review findings and the remaining order/lifetime defects exposed by repeated integrated runs.

The report commit is intentionally not self-referential; its hash is recorded in the final handoff.

## Baseline and classification method

The issue was read with:

```sh
gh issue view 350 --repo horang-labs/tessera --json number,title,body,url
```

Plain `gh issue view` was also attempted, but the installed `gh` queried GitHub's retired Projects Classic GraphQL fields. The JSON invocation returned the issue without mutating GitHub.

Baseline commands at `e7b3303`:

```sh
npx tsx --test --test-force-exit tests/*.test.mjs
npx tsx --test --test-force-exit tests/*.test.ts tests/*.test.tsx
```

- MJS: 354 tests, 342 pass, 12 fail, 0 skipped.
- TS/TSX first run: 1,619 tests, 1,611 pass, 6 fail, 2 skipped. Later runs had the five stable failures and no huge-diff failure, proving the sixth was order/chunk-sensitive.
- Each named failing file was also run alone. The 12 MJS failures and five stable TS/TSX failures reproduced alone. `git-commit-message.test.ts` passed alone, isolating the occasional sixth failure to output chunking/order rather than its high-level prompt contract.

Classification labels below mean:

- **Product regression** — public behavior was wrong and production code changed.
- **Stale contract** — behavior was correct, but coverage described a previous implementation or public shape.
- **Order/isolation** — timing, chunk boundaries, or unfinished work from another test changed the result.
- **Harness lifetime** — test-only resources prevented or prematurely ended a runner process.

## Failure-by-failure disposition

| Baseline failure | Classification | Evidence and replacement seam |
| --- | --- | --- |
| Deferred pre-start Session creation | Stale source-string contract | Both callers now use `buildTaskChildSession`. The contract invokes that public mapper and asserts `isRunning=false`, `hasStarted=false`, `status='starting'`; the narrow wiring checks only that both UI callers use the mapper. |
| New Tab singleton routing | Stale source-string contract | `openSingletonNewTab` is the public command and owns both Worktree Peek dismissal and singleton tab opening. Store/command tests assert state. The three React/Electron entry points have no non-private event-dispatch seam common to all runtimes, so the MJS test retains only the narrowest wiring check (shared import + invocation), rather than matching callback formatting or store internals. Packaged Electron event delivery is excluded below. |
| Project Strip scroll layout | Stale source-string contract | `scrollbar-none` and `overflow-x-hidden` still passed. The failed `max-sm:right-0 max-sm:top-0` clause was an unrelated running badge position deliberately changed to `right-1 top-1` by the phone-width work; it was removed rather than retargeted. There is no public non-browser seam for Tailwind scrollbar geometry. |
| Single-panel terminal header | Stale source-string contract | Replaced by calls to public `shouldShowSessionHeader`, including the terminal Chat View toggle case. |
| Atomic handoff exclusion | Stale source-string contract | Worktree removal moved from `session-orchestrator` into `archive-service`. Lock behavior is covered by `terminal-handoff-lock.test.ts`; `worktree-lifecycle-guard.test.ts` now calls the public archive API while a child Session is handed off, asserts `TerminalHandoffConflictError`, and verifies the checkout remains. |
| WSL filesystem read resolution | Stale source-string contract | Routes delegate through `resolveSessionWorkspaceFilesystemRoot`; `worktree-bridged-routing.test.ts` exercises WSL reported-path translation without mutating stored evidence. `agent-environment-paths.test.ts` covers host/guest path conversion. Route-specific regexes were removed rather than retargeted. |
| Empty terminal cwd | Stale source-string contract | `getInitialTerminalCwd(null, null) === null` verifies that a standalone terminal cannot borrow stale Session/project state. A user-selected project may now be passed explicitly by the empty-panel UI, which is a different and valid case. |
| Terminal source context | Stale source-string contract | Zustand state tests call `createTerminalPanel` and assert the created terminal retains `terminalSessionId` while clearing chat `sessionId`. |
| Terminal panel-to-tab move | Stale source-string contract | Public `moveTerminalPanelToNewTab` is tested through real tab/panel stores and preserves `terminalId`, `terminalSessionId`, `terminalCwd`, project, and prior active tab. |
| Codex WSL overlay | Stale source-string contract | Exact async construction changed, but `provider-launch-module.test.ts` launches Codex in a simulated Windows-hosted WSL topology and asserts guest command/home/skill placement. |
| OpenCode WSL overlay | Stale source-string contract | The same public provider-launch test covers OpenCode guest-native `OPENCODE_CONFIG_DIR` and overlay skill placement. |
| Workspace-folder Electron context menu | Stale source-string contract | `buildWorkspacePathContextMenuState` is tested for absolute host path, open capability, node, pointer position, and fail-closed missing path. The component keeps only a narrow handler wiring assertion because an Electron context-menu delivery seam is not available in the non-E2E suite. |
| Parent Worktree authority direct-SQL guard | Stale source-string contract | `server-message-routing` now delegates to `resolveSessionWorkspaceRoot`; the test verifies the public resolver returns the parent checkout and that the route contains no direct child-first SQL. |
| ChatLayout non-canonical target drop | Stale source-string contract | Public `resolveCanonicalGitTargetSessionId` drops optimistic `temp-` Sessions and Session targets hidden by Worktree Peek. Both Git surfaces retain a narrow resolver wiring assertion. The `temp-` domain predicate is shared with the Git controller. |
| Terminal input-bar key count/order | Stale behavioral contract | The product intentionally expanded to eight keys. Public API expectations now assert `escape, shift-tab, left, up, down, right, backspace, enter`. |
| Terminal input-bar sequences | Stale behavioral contract | Public API expectations now include left `ESC[D`, right `ESC[C`, and backspace `DEL`, alongside the existing sequences. |
| Workspace-file drag dual payload | Stale behavioral contract | The structured public payload intentionally gained optional `absolutePath`. Tests assert both its explicit `undefined` absence and preservation of a supplied host path while retaining panel/composer MIME payloads. |
| Occasional huge-diff cap failure | Product regression with order/chunk-sensitive manifestation | `runCommand` discarded a whole first chunk when it exceeded `maxOutputBytes`, so OS chunk boundaries could yield an empty diff. It now retains the exact capped prefix for stdout and stderr. |
| Six files alive after assertions | Harness lifetime defect | `pino-pretty`/`thread-stream` kept a worker `MessagePort`; the `ProcessManager` singleton kept a 5-second interval. Details are in the lifetime section. |
| Git action “answers without waiting” intermittent failure found during follow-up | Order/isolation defect | A previous test waited for only two of five background bystander broadcasts, cleared the shared capture array, then observed a late `legacy-bystander-session`. Every action test now waits on all active shared Session broadcasts, not a timer. |
| Terminal watchdog cancellations found after logger cleanup | Product lifetime regression exposed by harness cleanup | Awaited `stopSessionRuntime()` depended on an unreferenced watchdog, so Node could end with a pending Promise once the logger worker was gone. Awaited stops keep their watchdog referenced; fire-and-forget surface closes retain the production-safe unref behavior. |

## RED/GREEN TDD seams

All production behavior changes were driven at a public or process boundary:

1. **Git output cap** — RED: an oversized first stdout chunk returned `''` instead of 512 bytes. GREEN:

   ```sh
   npx tsx --test --test-force-exit --test-name-pattern "output past the cap|oversized first stdout chunk|huge diff" tests/git-runner.test.ts tests/git-commit-message.test.ts
   ```

   Result: 3/3 pass.

2. **Logger process lifetime** — RED: a child importing the logger under `NODE_TEST_CONTEXT=child-v8` timed out after 2 seconds. GREEN: a synchronous Pino destination writes the debug probe and exits; normal development still uses `pino-pretty`, and production logger options are unchanged.

3. **ProcessManager lifetime** — RED: importing the singleton in the same 2-second child probe timed out. GREEN: the health interval is unreferenced and the child exits.

   ```sh
   npx tsx --test tests/logger-lifetime.test.ts
   ```

   Result: 2/2 pass without force-exit.

4. **Shared UI state seams** — RED: tests for the new command/resolver/state modules failed with missing modules/functions. GREEN:

   ```sh
   npx tsx --test --test-force-exit tests/new-tab-command.test.ts tests/terminal-panel-context.test.ts tests/workspace-context-menu-state.test.ts tests/active-workspace-session.test.ts
   ```

   Result: 14/14 pass at the first green point.

5. **Git refresh isolation** — RED: integrated execution observed a late `legacy-bystander-session` after the next test cleared its capture array. GREEN:

   ```sh
   npx tsx --test tests/git-action-session-refresh.test.ts
   ```

   Result: 5/5 on five consecutive targeted runs.

6. **Awaited terminal stop** — RED after logger cleanup: `terminal-manager-cancellation.test.ts` reported six `cancelledByParent` tests beginning at “Session stop waits for forced watchdog shutdown”. GREEN:

   ```sh
   npx tsx --test --test-name-pattern "Session stop waits" tests/terminal-manager-cancellation.test.ts
   npx tsx --test tests/terminal-manager-cancellation.test.ts
   ```

   Results: 1/1 and 9/9; no cancelled tests.

Correct behavior that merely moved was characterized at existing public seams rather than forced through artificial RED production changes. That includes task-child mapping, terminal header visibility, WSL workspace resolution, provider WSL overlays, archive handoff exclusion, and drag payload parsing.

## Leak diagnosis and clean-exit evidence

A temporary preload diagnostic (removed before commit) established that Node test children set `NODE_TEST_CONTEXT=child-v8`. Active-handle reporting identified:

- a Pino/thread-stream worker `MessagePort` and associated timeout from the development `pino-pretty` transport;
- the `ProcessManager` singleton's 5-second health interval.

The fix is deliberately scoped:

- Node test children use `pino.destination({ sync: true })` with the same level and serializers. Development keeps `pino-pretty`; production debug/error behavior is unchanged.
- The ProcessManager health interval is `unref()`'d. Long-running servers already have listeners that keep them alive, so health checks continue while the server exists.
- Awaited terminal shutdown watchdogs remain referenced until their public Promise settles; fire-and-forget terminal closes remain unreferenced.

The six originally hanging files then exited naturally:

```sh
npx tsx --test tests/control-session-controller.test.ts tests/control-session-observer.test.ts tests/preparation-claim-timing.test.ts tests/request-gate.test.ts tests/ws-server-hardening.test.ts tests/ws-session-access-guard.test.ts
```

Result: 49/49, natural exit in approximately 2.77 seconds. No global force-exit is present in package scripts.

## Stable runners and final three consecutive suites

Added scripts:

```json
"test:unit": "tsx --test tests/*.test.ts tests/*.test.tsx",
"test:contracts": "tsx --test tests/*.test.mjs",
"test:non-e2e": "npm run test:unit && npm run test:contracts"
```

Final commands, run sequentially for each cycle without `--test-force-exit`:

```sh
npm run test:unit
npm run test:contracts
```

| Cycle | TS/TSX | MJS |
| --- | --- | --- |
| 1 | 1,630 tests; 1,628 pass; 0 fail; 0 cancelled; 2 skip; 28,499.334 ms | 354 tests; 354 pass; 0 fail/cancelled/skip; 1,557.950 ms |
| 2 | 1,630 tests; 1,628 pass; 0 fail; 0 cancelled; 2 skip; 28,693.429 ms | 354 tests; 354 pass; 0 fail/cancelled/skip; 1,369.575 ms |
| 3 | 1,630 tests; 1,628 pass; 0 fail; 0 cancelled; 2 skip; 28,450.295 ms | 354 tests; 354 pass; 0 fail/cancelled/skip; 1,596.029 ms |

The two skips are the suite's existing platform-conditional skips; the count was stable in every final run.

## Project View regression matrices

The requested “137” matrix gained the new canonical Git target test and is now 138/138:

```sh
npx tsx --test tests/active-workspace-session.test.ts tests/project-view-workspace-state.test.ts tests/project-view-workspace-state-activation.test.ts tests/project-view-task-mutation.test.ts tests/project-view-collection-placement.test.ts tests/project-view-session-lifetime.test.ts tests/project-view-cross-window-mutation.test.ts tests/project-view-dnd.test.ts tests/adaptive-linked-worktree-navigation.test.tsx tests/project-view-open-session.test.ts tests/project-view-tab-state.test.ts tests/project-view-unread-selector.test.tsx tests/recent-work-sort.test.ts tests/origin-project-representation.test.ts tests/kanban-board-scope.test.ts tests/kanban-project-projection-render.test.tsx tests/task-session-archive.test.ts tests/session-archive-client.test.ts tests/terminal-session-runtime-state.test.ts tests/project-view-session-scope.test.ts tests/project-view-worktree-scope.test.ts tests/project-view-membership-migration.test.ts
```

Result: 138/138, 0 skipped, 2,337.007 ms.

Contracts:

```sh
npx tsx --test tests/board-popout-live-sync-contract.test.mjs tests/kanban-collection-menu-contract.test.mjs tests/kanban-cross-project-dnd-feedback-contract.test.mjs tests/kanban-session-peek-contract.test.mjs tests/session-activation-focus-contract.test.mjs tests/tab-panel-persistence-contract.test.mjs tests/unread-notification-priority-contract.test.mjs tests/board-state-persistence-contract.test.mjs
```

Result: 38/38, 0 skipped, 542.664 ms.

These include Project A/C mutation, archive/restore, linked-session lifetime, unread selectors, and cross-window consistency.

## Authenticated browser E2E and visual evidence

Both tests use a seeded browser user, isolated temporary data and Git fixture directories, and a detached server process group owned by the test. Ports were confirmed unused before launch and empty after exit. No installed Tessera process or database was touched.

```sh
TESSERA_E2E_PORT=35650 TESSERA_EVIDENCE_DIR="$PWD/.tmp/issue-350-evidence/final-linked" node tests/linked-session-materialization.e2e.mjs
TESSERA_E2E_PORT=35651 TESSERA_EVIDENCE_DIR="$PWD/.tmp/issue-350-evidence/final-unread" node tests/project-view-unread-consistency.e2e.mjs
```

Results:

- Linked Session materialization passed in both Peek and split-tab modes. The browser asserted the linked Session did not duplicate as a Chat card and that Git targeted the canonical Worktree.
- Unread consistency passed. The browser asserted the task/sidebar and tab indicators both rendered `rgb(250, 204, 21)`.

Original-resolution images were inspected, not merely created:

- `.tmp/issue-350-evidence/final-linked/linked-session-peek.png` (58,585 bytes): linked Session modal visible with the Worktree Git panel.
- `.tmp/issue-350-evidence/final-linked/linked-session-tab.png` (61,622 bytes): the same Session materialized in the right split while the task remains in Doing.
- `.tmp/issue-350-evidence/final-unread/unread-tab-sidebar-consistency.png` (76,077 bytes): matching yellow unread state in the linked task row and Session tab/sidebar presentation.

## Static and graph verification

```sh
npx tsc --noEmit
npm run lint
git diff --check
graphify update .
```

- TypeScript: exit 0, no diagnostics.
- ESLint: exit 0, zero errors. Three pre-existing warnings remain in `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`; none is in this diff.
- Diff check: exit 0.
- Graphify: exit 0; final graph 10,972 nodes, 28,895 edges, 410 communities. `graphify-out` is ignored generated state and was not committed.

## Two-axis code review against `e7b3303`

The `$code-review` skill ran Standards and Spec reviewers in parallel, read-only, against:

```sh
git diff e7b3303...HEAD
git log e7b3303..HEAD --oneline
```

### Standards review

No hard documented-standard violations. Two judgement-call findings:

1. **Middle Man:** `openSingletonNewTab` initially only delegated to the store. Resolved: it now owns the user-command policy of closing Worktree Peek before opening/reusing a pristine New Tab; the public state test asserts both effects.
2. **Duplicated Code / Primitive Obsession:** optimistic `temp-` Session detection existed in two Git seams. Resolved: `isOptimisticSessionId` is the shared domain predicate used by both the Git controller and canonical target resolver.

### Spec review

1. **Report/evidence absent from the first implementation commit.** Resolved by this report, including exact classifications, runs, visuals, exclusions, and hashes.
2. **Retargeted source assertions.** Actionable atomic-handoff source matching was removed and replaced with an archive API integration test. New Tab, ChatLayout, and context-menu tests pair public state behavior with only minimal component wiring because React/Electron delivery has no common non-private unit seam; this is the explicit narrow-seam exception requested by the user, not a regex matching refactored formatting or internals.
3. **Named contracts appeared removed without mapping.** Resolved in the classification table: the Project Strip failure was an unrelated stale phone badge position, WSL reads are covered through the bridged resolver, and Codex/OpenCode overlays are covered through public provider launches in a simulated Windows-hosted WSL topology.

While running the review verification, the aggregate script revealed the Git refresh isolation defect; after that fix, removing the logger worker exposed the awaited terminal watchdog defect. Both were fixed and the entire verification sequence was rerun.

## Deliberate exclusions

- No push, PR, GitHub issue comment/close/edit, label change, or other GitHub mutation was performed.
- No packaged Windows Electron build or Windows-server/WSL-CLI topology claim is made. Per the request, packaged Electron QA remains the orchestrator's post-integration responsibility. Browser E2E proves the authenticated WSL web-server path only.
- Temporary handle probes were removed. Evidence images remain under ignored `.tmp/issue-350-evidence/`; test data directories and owned server process groups were removed by the E2E harness.
- No broad process cleanup was used. Owned E2Es used their exact detached process groups; ports 35650/35651 were empty after completion. No bare `pkill -f` or image-name kill was used.

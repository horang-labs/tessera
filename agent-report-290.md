# Issue #290 implementation report

## Outcome

Implemented GitHub issue #290 against fixed point `0c97284a0878b42c48a2550b3c31c9765d15206a`.
Project views now keep tab state and Collection placement local while every appearance retains the canonical Session ID and all ID-based conversation mutations remain global.

Implementation commits:

- `bdafe25e8c26ad845b42747ea44db69665b66d18` — primary implementation and integration tests.
- `c685bd775b5654ff24d28fabbf65129f014eb90b` — review fixes for scoped fallback and Board Peek context.

The branch began exactly at the fixed point: before implementation, `HEAD`, `git merge-base HEAD <fixed-point>`, and the fixed point all resolved to `0c97284a0878b42c48a2550b3c31c9765d15206a`.

## Acceptance-criterion mapping

| Acceptance criterion | Implementation and evidence |
| --- | --- |
| Same canonical Session opens independently in Projects A and C | `tab-store.ts` resolves the Session through the current Project projection before assigning `projectDir`; `project-view-tab-state.test.ts` proves distinct A/C tab IDs for one Session ID. Browser storage showed separate A and C Project entries containing `shared-session`. |
| Closing/selecting in one Project does not change the other | Project tab snapshots remain keyed by Project. The tab test exercises selection, active panel targets, and close isolation. Browser QA closed C's shared tab, switched to A, and restored A's original tab/panel ID. |
| Navigation/reload restores through selected Project projection | `getSession(sessionId, projectDir)` prefers the requested projection and converts any canonical fallback into the requested Project appearance with no foreign Collection. The reload test restores C, then A, from persisted v3 state. Headful reload retained the C Project and C tab ID. |
| Use Collection only when it belongs to selected Project | `project-view-projection.ts` validates Session and Worktree Collection IDs against the selected Project's Collection set at grouped, paginated, status, and Worktree read boundaries. |
| Invalid foreign Collection is Uncategorized and accessible | Invalid IDs become `null`/`undefined`, which existing UI groups as `Other` (the current label for Uncategorized). Integration tests cover direct Sessions, status pagination, and linked Worktrees. Browser QA opened the shared Session from Project C's `Other` group and from Board Peek. |
| Collection rename/move/delete does not copy/synchronize | The database integration test renames and reorders A's Collection, confirms C is unchanged, deletes A's Collection, and confirms C's Session retains C's Collection. No Collection copy or per-Project overlay was added. |
| Session identity and conversation mutations remain global | Projection retains `originProjectId` and the canonical Session ID. Existing ID-based mutations were left global; integration coverage proves a title mutation appears in both projections and existing coverage proves runtime/read changes update both appearances. |
| Integration coverage | Added `project-view-tab-state.test.ts` (152 lines) and `project-view-collection-placement.test.ts` (125 lines); extended the existing Peek contract test. Every new test file remains under 200 lines. |

## Files and architecture changed

- `src/lib/projects/project-view-projection.ts`: central Project View read boundary now validates local Collection placement for direct Sessions and linked Worktrees.
- `src/stores/session-store.ts`: `getSession` accepts an optional Project view locator. It returns the requested appearance and uses foreign data only as canonical payload, rewriting the view directory and clearing foreign Collection placement.
- `src/stores/tab-store.ts`: tab creation resolves shared Sessions in the current Project view rather than assuming the first owning directory.
- `src/components/chat/chat-area.tsx`, `header.tsx`, `message-input.tsx`, `message-list.tsx`: the selected Project view is carried to Session consumers that use Project-local placement.
- `src/components/board/session-peek.tsx`: Project-scoped Peek uses the Board's selected Project; All Projects remains intentionally unscoped.
- `tests/project-view-tab-state.test.ts`, `tests/project-view-collection-placement.test.ts`, `tests/kanban-session-peek-contract.test.mjs`: tab, reload, canonical fallback, Collection, and Peek coverage.

No canonical Session table, identity, transcript, or mutation API was duplicated or made Project-owned.

## Verification

Test-first failures were observed before each behavior change:

- The initial Collection test returned `collection-c` where Project A required `null`.
- The initial tab test assigned Project C's tab to `project-a` and failed reload isolation.
- Review-fix tests failed because explicit C lookup returned `project-a`, and Peek lacked selected-Project plumbing. Both passed after the corrective change.

Final commands and measured results:

```text
node --import tsx --test tests/project-view-tab-state.test.ts tests/project-view-collection-placement.test.ts tests/linked-worktree-independent-project.test.ts tests/project-view-open-session.test.ts tests/project-view-session-scope.test.ts tests/tab-session-open.test.ts tests/tab-new-tab.test.ts tests/kanban-board-scope.test.ts tests/kanban-session-peek-contract.test.mjs
=> 30 tests, 30 passed, 0 failed, 0 skipped; 0.849 s

npx tsc --noEmit
=> exit 0; no diagnostics; 4.32 s

npm run lint
=> exit 0; 0 errors, 3 pre-existing warnings in preview-markdown.tsx, use-virtual-message-list.ts, and spawn-cli-runtime.ts; about 39.3 s

git diff --check
=> exit 0; no whitespace errors

graphify update .
=> 9,996 nodes, 26,515 edges, 412 communities; graph rebuilt successfully
```

The repository-wide full suite was not run, as directed.

## Browser evidence

The documented dev-server procedure was used with inherited Tessera variables checked first. The server ran only against disposable data at `/home/work/tmp/tessera-290-browser-yvuq4R/data`; the repository and both Project views were also disposable. Browser automation was headful on `DISPLAY=:99` with persistent Playwright session `t290`; WSLg was not used.

- `.playwright-cli/evidence-290/project-a-local-collection.png` and `.yaml`: Project A showed Shared Canonical Session in `A Local`, while C Local Session appeared under `Other`.
- `.playwright-cli/evidence-290/project-c-independent-tab.png` and `.yaml`: Project C showed the same canonical Session in its own tab; persisted state contained distinct A/C tab and panel IDs.
- `.playwright-cli/evidence-290/project-c-reload-restored.png` and `.yaml`: reload restored Project C's selected projection and tab.
- `.playwright-cli/evidence-290/project-a-survives-c-close.png` and `.yaml`: after closing C's shared tab, switching to A restored A's original shared tab and active panel.
- `.playwright-cli/evidence-290/project-c-board-peek-after-review.png` and `.yaml`: Project C Board showed the foreign Session under `Other`; opening it produced the shared GUI Peek while Project C remained selected.

The disposable seed has no real Codex runtime or transcript. Expected background requests to Codex model/session options and skills produced 500/503 responses, plus one temporary Git-ref 400; Project/session/Collection APIs and the acceptance flow remained successful. Electron was not used because the changed behavior is an in-process Project projection/store/UI concern and does not cross a process, OS, filesystem, or network boundary.

## Standards and Spec review

### Initial Standards

- One hard finding: explicit Project lookup fell through to another Project's appearance unchanged, which could leak its `projectDir` and Collection. Accepted and fixed in `c685bd7` by re-projecting canonical fallback data into the requested Project and clearing Collection placement.
- One heuristic: the `sessionId`/`projectViewDir` pair is threaded through several chat components (possible Data Clump). Not implemented: Peek has a synthetic tab ID and therefore cannot derive a real Project from current `TabIdContext`; introducing a new cross-surface context/locator abstraction would enlarge this ticket and its regression surface. The explicit optional parameter is typed, small, and covered at both tab and Peek entry points.

### Initial Spec

- P1: Board Peek bypassed the selected Project projection. Accepted and fixed by resolving `selectedProjectDir`, treating All Projects as unscoped, and passing the concrete Project through `ChatArea`.
- P1: scoped lookup returned another Project's projection on a miss. Accepted and fixed as described above, with a red/green regression test.

### Final Standards

- Prior hard finding resolved; no documented-standard violations.
- The reviewer repeated the Data Clump/possible Shotgun Surgery heuristic. Rejected for the concrete scope and synthetic-Peek reasons above. Residual risk noted: fallback conservatively clears Collection without querying the requested Project's Collection list; normal backend projection retains valid local placement, while unloaded/hidden fallback intentionally prefers safe Uncategorized placement.

### Final Spec

- Pass: no remaining findings or scope creep. Both initial P1 findings were verified resolved.
- Residual test risk: Peek's automated test is source-contract based; this was supplemented by the headful Project C Board Peek evidence listed above.

## Not verified

- The full repository test suite, by explicit instruction.
- A real provider conversation/transcript mutation in the disposable browser seed; global title/runtime/read mutation behavior is covered by focused integration tests.
- Windows Electron behavior, because no OS/process/filesystem/network boundary is involved.

## Deliberately excluded scope

- Per-Project Session copies, Collection copies, or new placement-overlay persistence.
- Moving/reparenting canonical Sessions or Worktrees between Projects.
- Database migrations or changes to canonical Session lifecycle semantics.
- Unrelated lint warnings, dependency audit findings, provider-runtime setup, and existing dev-toolbar behavior.
- Pushes, PR creation, and any mutation of user repositories, worktrees, sessions, or databases.

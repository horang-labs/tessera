# Agent report — GitHub issue #292

## Outcome

Implemented issue #292 from fixed point `0c97284a0878b42c48a2550b3c31c9765d15206a`.
The selected-Project Kanban now consumes the same Project View Projection split as the
sidebar: projected direct Sessions are Chat cards and projected immediate linked
Worktrees are Worktree cards. Global surfaces collapse alternate Project appearances to
one stable origin representative. No code or report was pushed and no PR was opened.

Implementation commits:

- `dca75fb74946b6b93a7245344166783ef7ca188b` — primary implementation and tests
- `74881a06261c54f7b5336c72d40f4e05af31445b` — projection review fixes
- `ea8b8a385eba0d6fdaadc2a964b3a35ef2a5e21e` — fresh global task-projection preload
- `1625fc8f5df55643b92b94dcbd338c852fb4d1aa` — bounded preload failure retries
- `cd208b634954a47d9a2243501c24957232cc0d13` — isolated task-projection loading policy

## Acceptance-criterion mapping

| Acceptance criterion | Implementation and evidence |
| --- | --- |
| Selected Project Kanban uses the sidebar projection | `selectKanbanProjectionItems` consumes projected direct Sessions and projected Tasks without re-inferring ownership from `taskId`; `buildCollectionGroups` now trusts the same server Task projection. Projection parity test covers a populated linked Worktree. |
| Branch switch hides/restores identical items | Branch-change events refresh both Project Sessions and Task projection caches. Headful A/main → A/other → A/main evidence shows both list and board changing from the same two items to zero and back. |
| Direct Sessions are Chat cards; linked Worktrees are Worktree cards | Render test sends the exact Kanban selector output through `KanbanChatCard`/`KanbanTaskCard`. C headful evidence shows both canonical and direct C Sessions with chat-card test IDs. |
| Zero-Session linked Worktree remains visible | Task projection is authoritative even without child Sessions. C evidence shows `Zero Session D Worktree`. |
| No synthetic Project Worktree card | Kanban receives only direct Sessions and immediate linked Worktree Tasks. C DOM evaluation returned `projectRootCard: false`. |
| Project C uses C branch/direct/immediate projection | Existing real Git/SQLite projection tests plus C board evidence show two C direct appearances and descendant D, without A/C ownership mutation. |
| All Projects represents each canonical item once at origin | `buildOriginProjectRepresentation` filters direct and Task-child appearances by `originProjectId`, deduplicates canonical IDs, and keeps origin Tasks. All Projects evidence shows Linked C, D, Direct A, and Direct C once each. |
| Recent Work, notifications, running navigation use stable origin | Recent Work and All Projects preload origin Task projections once per entry; notification navigation targets `originProjectId`; running/search navigation uses canonical representatives. Unit and source-contract tests cover origin/dedup. |
| Task status and Peek remain intact | Non-owning Project views do not acquire A Task operations merely because its canonical Session appears directly in C. Existing task-status/archive and Peek contracts pass. |
| Projection and rendered tests | `kanban-board-scope.test.ts`, `kanban-project-projection-render.test.tsx`, origin representation tests, real Project View lifecycle tests, and the headful evidence below cover the required cases. |

## Files and architecture changed

- `src/lib/kanban/board-scope.ts` and `src/components/board/kanban-board.tsx` now consume the Project View read-model split directly and collection-filter it once.
- `src/lib/chat/build-collection-groups.ts` keeps every Worktree in the authoritative linked-Worktree projection, independent of child Session visibility.
- `src/lib/projects/origin-project-representation.ts` owns canonical origin selection for aggregate surfaces; `src/lib/tasks/project-task-projection-loading.ts` separately owns global cache readiness/retry selection.
- `src/components/chat/sidebar.tsx`, `all-projects-list.tsx`, and `recent-work.ts` use origin-only global projections and preload missing task projections without unbounded failure retries.
- running panel, session navigation, notification center, and toast navigation resolve canonical origin locations.
- branch refresh in `session-store.ts` reloads both Session and Task projections.
- Added/updated focused tests for C parity, populated and zero-Session Worktrees, origin-only global rendering, fresh-cache loading, branch refresh, Recent Work, notifications/running navigation, archive/status, and Peek.

## Verification

Mandatory intake/orientation:

- `gh issue view 292 --repo horang-labs/tessera --json number,title,body,url,state` — complete open ticket read.
- `git rev-parse HEAD` and `git merge-base HEAD 0c97284a0878b42c48a2550b3c31c9765d15206a` before editing — both resolved to the fixed point; initial worktree was clean.
- Read `AGENTS.md`, triggered repository notes, `CONTRIBUTING.md`, issue-tracker/domain guidance, and ADRs 0001–0005.
- `graphify reflect --if-stale`, expanded query `[kanban, project, view, projection, scope, session, worktree, sidebar, origin, filter]`, targeted `query`/`explain`, and `graphify update .` after changes — graph updated successfully (final: 10,009 nodes, 26,571 edges).

Final focused command:

```text
node --import tsx --test tests/linked-worktree-independent-project.test.ts tests/project-view-worktree-scope.test.ts tests/project-view-session-scope.test.ts tests/project-view-open-session.test.ts tests/kanban-board-scope.test.ts tests/kanban-project-projection-render.test.tsx tests/origin-project-representation.test.ts tests/recent-work-sort.test.ts tests/task-session-kind.test.ts tests/task-session-archive.test.ts tests/notification-store-dedup.test.ts tests/kanban-session-open-mode.test.ts tests/session-activation-focus-contract.test.mjs tests/kanban-session-peek-contract.test.mjs
```

Result: **54 passed, 0 failed**, 2.65 seconds. Tests used isolated temporary Git
repositories and SQLite data. No repository-wide full suite was run, as instructed.

Other final commands:

- `npx tsc --noEmit` — exit 0, 4.83 seconds, no diagnostics.
- `npm run lint` — exit 0, 26.21 seconds; 0 errors and 3 pre-existing warnings in `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`.
- `git diff --check` — exit 0, 0.00 seconds.

## Headful browser evidence

Before startup, `env | grep -i tessera` was checked. No inherited
`TESSERA_APP_ROOT`, production DB target, or Electron server target was used. Port 3100
belonged to another process and was left untouched; the isolated server used 3292 and
`/home/work/tmp/tessera-292-browser-0irFty/data`. The isolated A/C/D Git repositories and
database were the only lifecycle data mutated.

Server command:

```text
env -u TESSERA_APP_ROOT -u TESSERA_ELECTRON_SERVER -u __CFBundleIdentifier TESSERA_DATA_DIR=/home/work/tmp/tessera-292-browser-0irFty/data TESSERA_PRODUCTION_DB=1 TESSERA_ELECTRON_AUTH_BYPASS=1 PORT=3292 npm run dev
```

Browser automation used headful Xvfb, never WSLg:

```text
DISPLAY=:99 playwright-cli -s=t292 open http://127.0.0.1:3292/chat --persistent --headed
```

Evidence directory: `.playwright-cli/evidence-292/`.

- `project-c-board.{yaml,png}` — three cards: zero-Session D Worktree Task, canonical C Session as a Chat card in Todo, and Direct C Chat; no Project C root card.
- `all-projects-board.{yaml,png}` — Linked C Worktree, zero-Session D Worktree, Direct A Chat, and Direct C Chat each appear once at their origin.
- `project-a-main-list.{yaml,png}` and `project-a-main-board-final.{yaml,png}` — sidebar and board both show Linked C Worktree plus Direct A Chat.
- `project-a-other-list.{yaml,png}` and `project-a-other-board.{yaml,png}` — after isolated A checkout to `other`, both surfaces show zero scoped items.
- `project-a-main-restored-list.{yaml,png}` and `project-a-main-restored-board.{yaml,png}` — switching back to `main` restores both surfaces.
- `playwright-cli -s=t292 console error` — 0 browser console errors at completion.

Electron was intentionally not used: this read-model/UI behavior does not cross a
Windows/WSL process, filesystem, or network boundary, so the documented WSL dev-browser
topology is sufficient.

## Standards and Spec review

The actual `$code-review` skill ran independent read-only Standards and Spec agents
against `git diff 0c97284a0878b42c48a2550b3c31c9765d15206a...HEAD`.

Initial Standards findings:

1. Hard: running origin Task Sessions could disappear from All Projects.
2. Judgement: All Projects reconstructed origin logic instead of using the shared representation.
3. Judgement: Kanban repeated collection filtering.
4. Judgement: `filterKanbanTasks` no longer described its narrowed behavior.

All four were applied and later confirmed resolved. A later one-line running-predicate
duplication suggestion was withdrawn by the reviewer because reuse would invert the
chat→Project dependency or create speculative generality. The terminal Standards review
had no hard violations and one Divergent Change judgement about cache retry policy living
in the origin module; it was applied structurally by moving that policy to
`project-task-projection-loading.ts`. No behavior changed after that review.

Initial Spec findings:

1. Valid: populated linked Worktrees could differ between sidebar and Kanban — fixed by trusting the Task projection in both.
2. Rejected: projected canonical Sessions should gain Chat ownership operations. This conflicts with ADR-0001/0004 non-owning views and “task status intact”; the final Spec reviewer agreed it is not a defect.
3. Initially disputed: rendered/integration evidence was incomplete. Exact selector/card render tests plus the required headful A/C/All and branch captures were supplied; the final Spec reviewer accepted the combined evidence.

Subsequent valid Spec findings were applied: fresh All Projects task caches are preloaded
for Recent Work, and failed loads are bounded to one attempt per All Projects entry. The
terminal Spec review reported **no findings**.

## Not verified / deliberately excluded

- The repository-wide full test suite was deliberately not run; the orchestrator owns that decision.
- Windows Electron was deliberately not run because no process/OS/filesystem/network boundary is involved.
- A live failed HTTP preload was not forced in browser QA; the pure readiness/retry selector test covers loaded, loading, fresh, and already-attempted states.
- No schema migration, canonical ownership transfer, Task/Worktree lifecycle coupling, user worktree/session/database mutation, push, or PR was in scope.

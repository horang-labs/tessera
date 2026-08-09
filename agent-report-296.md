# Agent report — GitHub issue #296

## Outcome

Implemented issue #296 from fixed point
`13cbea05cc30b5730b4b873ab275cdfcd48478d1`. Project View membership now comes
from canonical Worktree identity (or an explicit non-Git Project membership),
and the Project View Projection is the shared read boundary for direct Sessions,
linked Worktrees, branch scope, Collection fallback, Kanban, and reference
pickers. Obsolete Project-owned reassignment/reorder APIs and UI strings were
removed. The final review fix also separates a Task's representative origin
Project from the Project View currently presenting it.

Implementation commits:

- `d83dc028d35d3cc2640e0d65a3a8fb1b9f2311e2` — retire Project-owned fallbacks
- `9c7f0ac664db11391136add3edc3ecfbb889d507` — fix review findings in legacy
  standalone migration and origin/view identity
- `dc9c0d210ac199960b3ef833b0803e36d2819a36` — route cross-environment legacy
  paths through the authenticated agent environment
- `963ce0b2248ca3b95608b219dbc79bc548d50554` — close authenticated reference
  routing and selected-view Task mutation gaps
- `6f4606a09e0e6d038778dc4bf650e779b3338ef7` — synchronize archive/delete and
  Collection reorder across Project appearances

Nothing was pushed or merged; no PR was opened and issue #296 was not changed.

## Acceptance mapping

| # | Acceptance criterion | Result and evidence |
|---|---|---|
| 1 | Sidebar and selected-Project Kanban have one semantic source | Implemented through `getProjectViewProjection()` and its explicit canonical/non-Git membership union. Sidebar, Kanban, task API, and `@` reference classification consume this projection. Direct Sessions and immediate Worktrees use the same branch/null-scope and Collection masking policy. |
| 2 | Migrated navigation and state paths do not infer membership from remembered Project directories | Implemented. Session/Task queries, worktree lifecycle, reorder, websocket creation, resume, tabs, panels, notifications, Recent Work, running projection, and Kanban were traced. Membership uses `worktree_id` and Creation Scope. `projectViewId` now drives current-view tab/panel/session presentation while `projectId` remains representative origin metadata. |
| 3 | Origin Project metadata is clearly separate | Implemented with required `originProjectId` for Sessions and `projectViewId` alongside the Task's stable representative `projectId`. All Projects/global aggregate helpers deliberately use origin representatives; selected-view navigation uses `projectViewId`. |
| 4 | Obsolete fallbacks removed after consumer migration | Implemented. Raw Project-owned Project View query APIs were replaced by membership-aware APIs; `COALESCE`, `task_id OR worktree_id`, Project-scoped reorder, unused resume directory, reassignment store methods, and compatibility aliases were removed after their callers moved. |
| 5 | Move to Project is unreachable | Implemented. The task-session reassignment route and DB/store mutation path were removed, `updateSession()` cannot mutate `project_id`, and stale Move to Project strings/types were removed from every locale. The source contract test passes. Creating a new Session in an existing Worktree remains available and is not reassignment. |
| 6 | Migration is idempotent and legacy records remain accessible | Implemented as schema v38 plus repeatable startup/registration backfill. Task children use their Task Worktree ID; taskless native/same-spelling rows match a registered checkout without filesystem interpretation; cross-environment CLI paths remain pending until authenticated routing translates them using the configured agent environment. Only pathless recoverable rows use the Project Worktree. Legacy null branch remains visible on every branch. The migration test runs startup twice and compares identical state. |
| 7 | Complete non-Electron Project View integration matrix | Passed: 113 tests covering branch switching, A/C projection, Collections, adaptive density, Kanban, lifecycle, rename warning, legacy migration, bridged/native routing, tabs, side targets, canonical Task mutations, archive, websocket/running state, and stale ownership interfaces. |
| 8 | Rendered acceptance | **Partially verified without browser/Electron.** Component/static-render and state tests cover Project Worktree selection, identity/icons, zero/one/many density, Project-local tabs, and side-panel targets. A real rendered browser/Electron pass was prohibited and remains unverified. |
| 9 | Windows Electron + WSL CLI | **Unverified for #296.** No new Electron run was permitted. Only the explicitly partial #295 evidence described below is carried forward; it is not claimed as a new pass. |
| 10 | Non-Git and native behavior | Passed in the projection, native Worktree-root, path-routing, and control matrix. Non-Git membership is an explicit union variant rather than a Git fallback. |

## Intake and design constraints

Read before implementation:

- `AGENTS.md` and `CONTRIBUTING.md` in this Worktree.
- Issue #296 in full. `gh issue view 296 --comments` failed because GitHub's
  classic Projects field is retired; `gh api repos/horang-labs/tessera/issues/296`
  succeeded and returned the complete title/body.
- Parent/blocked issue context through `gh api`.
- `../0809-t294/docs/adr/0001` through `0005`: Projects as Worktree views,
  immutable Worktree Creation Scope, Session creation-branch scope, separate
  Session/Worktree lifecycles, and first-class Project Worktree targets.
- `CONTRIBUTING.md` and the repository's documented test/scope expectations.

Graphify was used only for orientation, followed by reading actual callers and
SQL branches:

```text
graphify query "ProjectViewProjection canonicalWorktreeIdentity sessionWorktreeId projectWorktreePath" --budget 2200
graphify explain <projection/session/task/worktree/route nodes selected from the query>
```

After implementation and review fixes, `graphify update .` succeeded and rebuilt
the ignored graph to 10,161 nodes, 26,835 edges, and 395 communities.

## Implementation details

- Schema v38 backfills immutable Session Worktree/branch membership and Worktree
  Creation Scope. Repetition is safe. Startup does not interpret CLI-owned
  paths; authenticated canonical routing translates cross-environment legacy
  paths before reconciling their Worktree IDs.
- New Session persistence resolves its canonical Worktree from the Task,
  explicit ID, or actual Git checkout and captures its branch scope.
- Git ordering is Worktree/branch scoped; non-Git ordering remains explicitly
  Project-local.
- Project View queries accept only `ProjectViewMembership` and contain no
  Project-ownership compatibility predicates.
- `originProjectId` is required for canonical Session representations.
  `TaskEntity.projectId` is representative origin metadata and the required
  `projectViewId` is the current projection used for selected-view navigation.
- Websocket `session_created` carries an explicit Project ID instead of asking
  the client to infer it from a work directory.
- Files/reference lookup requires the active Project View and classifies direct
  Chats versus Worktree children through the same projection. The authenticated
  route completes canonical path routing before that projection read.
- Canonical Task title/status mutations update every cached Project appearance;
  origin-only Collection placement is updated only in its origin view, and
  Kanban/Collection reordering groups by the selected `projectViewId`.
- Archive and Worktree deletion remove every cached appearance and reload every
  affected Project View if the server mutation fails.
- Worktree lifecycle routing uses exact Worktree IDs; Project Worktree guards,
  sessionless targets, archives, rename warnings, Collections, Recent Work, and
  global representatives remain intact.

## Verification commands and results

No command below started a dev server, browser, Electron instance, E2E harness,
CDP, PowerShell, Windows app/build, or Windows process inspection.

Test-first evidence:

- Before the initial implementation, focused tests for Project-owned fallback
  rows, missing Task Session identity, stale Move strings, and absent migration
  failed as expected.
- Before the review fix:
  `node --import tsx --test tests/project-view-membership-migration.test.ts tests/adaptive-linked-worktree-navigation.test.tsx`
  — 7 passed, 2 failed, proving the linked-standalone migration and
  origin/view-navigation regressions.
- After the review fix, the same command passed 9/9.

Broad Project View Projection matrix:

```text
node --import tsx --test \
  tests/project-view-membership-migration.test.ts \
  tests/project-view-session-scope.test.ts \
  tests/project-view-worktree-scope.test.ts \
  tests/linked-worktree-independent-project.test.ts \
  tests/project-view-collection-placement.test.ts \
  tests/project-view-task-mutation.test.ts \
  tests/adaptive-linked-worktree-navigation.test.tsx \
  tests/kanban-board-scope.test.ts \
  tests/kanban-project-projection-render.test.tsx \
  tests/project-worktree-target.test.tsx \
  tests/project-view-tab-state.test.ts \
  tests/project-view-open-session.test.ts \
  tests/project-branch-rename-warning.test.ts \
  tests/origin-project-representation.test.ts \
  tests/recent-work-sort.test.ts \
  tests/task-session-kind.test.ts \
  tests/task-session-archive.test.ts \
  tests/worktree-lifecycle-guard.test.ts \
  tests/worktree-bridged-routing.test.ts \
  tests/control-worktree-creation.test.ts \
  tests/git-action-session-refresh.test.ts \
  tests/terminal-session-runtime-state.test.ts \
  tests/ws-session-access-guard.test.ts \
  tests/session-websocket-broadcast.test.ts \
  tests/project-ownership-transfer-contract.test.mjs
```

Final result: exit 0, 113 passed, 0 failed, 0 skipped. Before review fixes, the
corresponding 24-file matrix passed 108/108.

After the cross-environment review fix, the same 24-file matrix again passed
110/110, followed in the same shell chain by successful `npx tsc --noEmit`,
`npm run lint`, and `git diff --check`.

After the final reference/Task-cache review fix, the matrix added
`tests/project-view-task-mutation.test.ts` and passed 111/111. The focused
command
`node --import tsx --test tests/project-view-task-mutation.test.ts tests/project-ownership-transfer-contract.test.mjs`
passed 2/2; `npx tsc --noEmit`, `npm run lint`, and `git diff --check` also
passed.

After the final lifecycle fix, the same focused command passed 4/4 (canonical
mutation, Collection isolation, archive, and deletion); TypeScript, lint, and
diff checks passed again. The complete 25-file matrix was then rerun and passed
113/113 with no failures or skips.

Final focused regression command:

```text
node --import tsx --test \
  tests/kanban-board-scope.test.ts \
  tests/origin-project-representation.test.ts \
  tests/kanban-project-projection-render.test.tsx \
  tests/task-child-session-cwd.test.ts \
  tests/task-session-kind.test.ts \
  tests/recent-work-sort.test.ts \
  tests/project-view-membership-migration.test.ts \
  tests/adaptive-linked-worktree-navigation.test.tsx
```

Result: 32 passed, 0 failed. The first attempt exposed one stale test fixture
that still supplied removed `projectId` Session shape (31/32); updating it to
required `projectDir` + `originProjectId` made the rerun pass.

Other checks:

- Central projection seam set — 26 passed, 0 failed.
- Ownership-removal source-contract set — 9 passed, 0 failed.
- `npx tsc --noEmit` — exit 0 with no diagnostics before and after review fixes.
- `npm run lint` — exit 0 with 0 errors and exactly 3 pre-existing warnings:
  `preview-markdown.tsx` (`<img>`), `use-virtual-message-list.ts` (incompatible
  library), and `spawn-cli-runtime.ts` (unused directive).
- `git diff --check` — passed before every implementation/review commit and at
  closeout.
- `graphify update .` — passed after initial implementation and after review
  fixes.

One diagnostic attempt included the repository's stale
`tests/terminal-contract.test.mjs` and reported 90/98 because eight unrelated
source-string contracts predate this ticket. Another combined diagnostic
reported 28/29 because `parent-worktree-authority.test.ts` retains one unrelated
stale source-string assertion. Relevant behavioral tests in those attempts
passed; neither diagnostic is counted as passing evidence, and unrelated code
was not rewritten.

## Two-axis code review

The actual `$code-review` workflow ran independent read-only Standards and Spec
agents against
`git diff 13cbea05cc30b5730b4b873ab275cdfcd48478d1...HEAD`.

Initial findings:

- **Standards:** no hard documented-standard violation. One judgment call noted
  repeated interpretation of the canonical membership/null-branch policy in
  Session and Task SQL, plus the expected runtime/platform evidence gap.
- **Spec, High:** taskless legacy Sessions with a linked `work_dir` were assigned
  the origin Project Worktree instead of the checkout's canonical Worktree.
- **Spec, Medium:** Task origin metadata still drove selected-view linked
  Worktree Session/tab navigation; no separate current-view field existed.
- **Standards rerun, High:** the first checkout-first legacy repair
  canonicalized CLI-owned paths synchronously at database startup, without the
  authenticated user's agent environment. A Windows server and WSL CLI could
  therefore retain different path keys.
- **Standards rerun, Medium judgment accepted:** the Files/`@` reference route
  read Project View Projection before canonical routing, so a legacy bridged
  Session could be absent depending on request order.
- **Spec rerun, Medium:** selected-view Task updates and Kanban reorder still
  used origin `projectId` in several client cache/grouping paths.
- **Standards closure rerun:** delete/archive still changed only the origin
  cache, and Collection-local reorder still read the origin bucket.

Disposition:

- Accepted both Spec findings. Commit `9c7f0ac664db11391136add3edc3ecfbb889d507`
  adds checkout-first legacy migration, the required `projectViewId`, and tests
  proving origin and current view may differ.
- Accepted the Standards cross-boundary finding. Commit
  `dc9c0d210ac199960b3ef833b0803e36d2819a36` restricts synchronous startup to
  exact stored-path matches and moves cross-environment repair into
  `routeCanonicalWorktreePaths()`, whose callers first resolve the authenticated
  user's agent environment. A bridged routing test proves a null legacy Session
  receives the existing canonical Worktree ID and host-openable path.
- Accepted the Files read-order and selected-view mutation findings. Commit
  `963ce0b2248ca3b95608b219dbc79bc548d50554` routes before reference projection,
  updates canonical title/status in every cached Project appearance without
  leaking origin Collections, uses `projectViewId` for optimistic buckets and
  Kanban grouping, and adds focused regression coverage.
- Accepted the final lifecycle/reorder findings. Commit
  `6f4606a09e0e6d038778dc4bf650e779b3338ef7` synchronizes archive/delete across
  every appearance, reloads all affected projections on rollback, and uses the
  current view for Collection-local ordering.
- Rejected the Standards judgment call. Direct Sessions, child Sessions, and
  Worktrees use different tables, aliases, columns, and ownership semantics.
  A dynamic SQL-identifier/predicate builder would hide the local query meaning
  and add speculative abstraction; the domain union is centralized and parity
  is integration-tested.
- Rejected two additional Standards judgment calls: making `projectViewId`
  required prevents a missing-view compatibility fallback across the shared
  server/client entity, while raw/global Task readers deliberately use the
  origin representative as their view; extracting the two pre-existing
  session-creation workflows would be unrelated refactoring beyond #296.
- Rejected the suggestion to expose the current Project's Collections for a
  Worktree originating elsewhere. ADR 0001 deliberately keeps Worktree
  Collection placement in its origin Project and excludes per-Project overlays;
  the final cache mutation test proves that placement does not leak into an
  alternate view.
- Accepted the platform evidence gap as a documented safety limitation, not a
  code success.

Final post-material-fix review:

- **Standards:** no actionable hard findings. The cross-boundary, Files read
  ordering, lifecycle cache, and Collection reorder findings are fixed.
- **Spec:** no actionable implementation findings and no material scope creep.
- **Evidence:** both axes retain only the explicitly prohibited rendered and
  Windows Electron/WSL verification gaps.

## Prior #295 evidence and Electron safety limitation

Issue #296 performed no Electron verification. The only packaged evidence is
the explicitly partial evidence recorded by completed issue #295:

- An earlier isolated packaged run used a Windows Electron server with a WSL
  Git/CLI fixture and found/fixed real boundary defects around premature path
  conversion and double conversion.
- The sessionless Project Worktree Git/Files view completed and produced a
  screenshot whose recorded SHA-256 is
  `06fa50717f677e059cfd4e3a831f2ae8c91d3396cea4242bd45b4b1e464527c4`.
- The harness then timed out at a linked Worktree row. Standalone linked and
  one-Session composite navigation did not complete.
- Per-operation process attribution remained incomplete.
- Child Electron testing made the user's already-running parent Electron
  unresponsive.

Because of that incident, this work did **not** invoke `tessera-electron-dev`,
start or inspect any Electron/Windows process, touch the installed/parent app,
bind or inspect port 32123, access production data, run a browser/dev server, or
run a Windows build. Static request objects in Node tests contain the literal
`localhost:32123`; they neither listen nor connect and did not interact with the
real port.

Consequently acceptance criteria 8 and 9 retain real evidence risk: component
and state tests are green, but a new rendered browser pass and packaged Windows
Electron + WSL pass were intentionally not performed. The partial #295 result
must not be represented as a complete #296 Electron pass.

## Excluded scope and cleanup

- Excluded by instruction: Electron, browser E2E, dev server, CDP, PowerShell,
  Windows app/build/process inspection, installed Tessera, port 32123, and
  production data.
- Also excluded: unrelated stale source-string tests and pre-existing lint
  warnings.
- No push, merge, PR, issue mutation, or external cleanup was performed.
- The Worktree is clean after the report commit (verified at closeout).

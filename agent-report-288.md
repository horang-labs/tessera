# Agent report — GitHub issue 288

## Outcome

Implemented issue 288 on the current branch. Linked Worktrees now store immutable creation placement as the canonical originating Project Worktree plus its active branch, while Start Point is stored separately as Git provenance. Project views expose only immediate linked Worktrees whose stored placement matches the Project Worktree's live branch, restore them when that branch returns, and keep legacy null-scope rows branch-global.

Implementation commit: `88dbeec91eca4dfd179941b4b123640f53a2ee60` (`feat(projects): scope linked worktrees to creation branch (#288)`).

## What changed and why

- Advanced the SQLite schema from v35 to v36 with `tasks.creation_scope_worktree_id`, `tasks.creation_scope_branch`, and `tasks.start_point`, plus a scope index.
- Added database triggers that reject changes to an already-populated Creation Scope or Start Point. This makes placement and provenance immutable after capture.
- Captured the canonical Project Worktree ID, its active branch, and the independently selected Start Point in both linked-Worktree creation paths: the UI Worktree API and Control.
- Refused new linked creation before Git when the originating Project Worktree has no active branch. This prevents new scoped records from being confused with migrated legacy null-scope data; detached-HEAD support itself remains out of scope.
- Added the Project View Projection seam for immediate linked Worktrees. Exact origin/branch matches are visible; switching away hides them without deletion; switching back restores them. Legacy rows with no Creation Scope remain visible on every branch.
- Routed the tasks API and Control Worktree listing through the same Project View projection instead of treating `tasks.project_id` as view placement.
- Projected sessions from each linked Worktree's canonical identity and live branch. Project sessions are not copied into child Worktrees.
- Preserved the existing global/archive/direct-ID queries so hiding in a Project View does not destroy or globally erase data.

## Provider skill and `/tdd`

The provider's implementation workflow was invoked explicitly through `$implement`, with issue 288 treated as the supplied ticket. It was combined with the repository's graph-first navigation and `/tdd` workflow.

The following seams ran through `/tdd`:

1. Linked Worktree creation persistence: creation scope and Start Point captured through both Control and the UI API, including branch-off and checkout-existing creation.
2. Project View Projection at the real Git/SQLite boundary: origin A creating linked C, Start Point independence, branch hide/restore, immediate-only projection, canonical child sessions, legacy visibility, and immutable metadata.

The first Project View fixture was written before implementation. Its initial feature failure was `Cannot read properties of undefined (reading 'map')` because `linkedWorktrees` did not yet exist on the projection. Implementation then made the fixture green. A preliminary test setup issue was also corrected to use `createGitRunner('wsl')`; using the native runner inside WSL would incorrectly select the Windows-side binary in this repository's supported bridged topology.

The new real Git/SQLite acceptance fixture is `tests/project-view-worktree-scope.test.ts` at 196 lines, under the requested 200-line ceiling. The migration fixture is `tests/worktree-creation-scope-migration.test.ts` at 60 lines.

## Commands and measured results

### Ticket and design intake

- `gh issue view 288 --repo horang-labs/tessera` — the installed `gh` hit GitHub's removed Projects Classic GraphQL field.
- `gh issue view 288 --repo horang-labs/tessera --json number,title,body,url,state` — exit 0; issue contents loaded successfully without the removed field.
- Read `docs/adr/0001-projects-are-worktree-views.md` through `docs/adr/0005-make-project-worktrees-selectable-targets.md` before implementation.
- Fixed review point: `28315dc5b28e845d586ae5be0866ae4dd392143e`.

### Graph navigation

- `graphify reflect --if-stale` — completed; repository lessons were read before querying.
- Query expansion tokens used: `worktree`, `project`, `projection`, `scope`, `creation`, `branch`, `session`, `origin`, `linked`, `start`, `point`, `checkout`.
- `graphify query "worktree project projection scope creation branch session origin linked start point checkout" --budget 4000` plus `graphify explain` for `allocateManagedWorktree`, `ProjectViewSessionScope`, and `createGitWorktree` identified the creation and projection seams.
- Final `graphify update .` — exit 0; graph rebuilt to 9,952 nodes, 26,454 edges, and 375 communities. Generated graph files are ignored.

### Dependencies

- `npm ci` — exit 0; installed 1,042 packages. npm reported 46 dependency audit findings (2 low, 13 moderate, 28 high, 3 critical); dependency remediation was outside this ticket and no lockfile change resulted.

### Targeted verification

- `node --import tsx --test tests/project-view-worktree-scope.test.ts tests/project-view-session-scope.test.ts tests/worktree-creation-scope-migration.test.ts tests/session-scope-migration.test.ts`
  - 5 tests, 5 passed, 0 failed; 2,465.20 ms after the review fixes.
- `node --import tsx --test tests/control-worktree-creation.test.ts`
  - 6 tests, 6 passed, 0 failed; 4,936.80 ms after the review fixes.
  - Includes Control branch hide/restore and both Control/UI detached-origin refusal before Git.
- `node --import tsx --test tests/worktree-identity-persistence.test.ts tests/project-worktree-root.test.ts`
  - 7 tests, 7 passed, 0 failed; 2,509.78 ms.
- `npx tsc --noEmit`
  - Exit 0; no diagnostics.
- `npm run lint`
  - Exit 0; 0 errors and 3 unrelated existing warnings:
    - `src/components/chat/preview-markdown.tsx`: `@next/next/no-img-element`.
    - `src/hooks/use-virtual-message-list.ts`: React compiler incompatible-library warning for TanStack Virtual.
    - `src/lib/cli/spawn-cli-runtime.ts`: unused eslint-disable directive.
- `git diff --check`
  - Exit 0.

The full test suite was deliberately not run, per the ticket's child-worktree verification rule.

## Runtime-specific review

The requested `$code-review` skill was invoked exactly as the review mechanism. Before invocation, `git diff --quiet 28315dc5b28e845d586ae5be0866ae4dd392143e...HEAD` returned 1, confirming a non-empty fixed diff. Standards and Spec agents reviewed that same fixed point in parallel and read the documented ADRs; the Spec agent also read issue 288.

Initial findings:

- Standards: `ControlWorktreeSource.list()` still selected by `tasks.project_id`, bypassing branch-aware Project View placement. Applied by routing the Control list through `getProjectViewWorktrees()` and mapping its canonical projected sessions.
- Spec: new creation allowed a null active branch, which could make a newly scoped Worktree behave like branch-global legacy data. Applied by making new Creation Scope branches non-null, narrowing null behavior to rows without Creation Scope, and rejecting detached/unavailable-origin creation before Git in Control and the UI API.

After amending the implementation commit, both review axes were rerun in parallel against `28315dc5b28e845d586ae5be0866ae4dd392143e...88dbeec91eca4dfd179941b4b123640f53a2ee60`:

- Standards: no findings; the previous Control projection issue is closed.
- Spec: no actionable findings; the previous null-branch gap is closed.
- Scope creep: none.

## What could not be verified

- No visual or geometry claims were made, so no headful browser screenshots were captured.
- No acceptance behavior required a Windows-server/WSL-CLI process, OS, filesystem, or network crossing. The behavior was verified at the real Git/SQLite creation and read-projection boundaries; an isolated Windows Electron runtime was therefore not started.
- The orchestrator, not this child worktree, owns any decision to run the integrated full suite.

## Deliberately left out

- Advanced detached-HEAD placement support; linked creation now fails safely until the origin is on a branch.
- Recursive Worktree trees or descendant projection. Only immediate linked Worktrees are projected.
- Branch rename/repair policy for previously captured immutable branch scope.
- New UI layout or styling; this ticket changes persistence and read semantics only.
- Dependency vulnerability remediation, unrelated lint warnings, unrelated baseline contracts, and broad refactors.
- Push and PR creation, as requested.

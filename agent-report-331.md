# Agent report — GitHub issue #331

## What changed and why

Issue #331 required Worktree Task-derived state to travel through the canonical Project View workspace-state boundary instead of updating one store representation at a time.

- Extended `ProjectViewWorkspaceState` with stateful Task mutation and Todo-promotion transitions. The transition updates every loaded A/C Task appearance, every matching direct Session appearance, retained Sessions, status counts, archive state, and read-only state through one seam. It returns a rollback that restores all affected representations.
- Routed explicit workflow mutations, automatic Todo -> Doing promotion, Project-local Collection mutations, and Worktree Task archive through that seam.
- Kept the current Task-list mirror inside the seam when `tasksByProject` has not been populated yet, preserving terminal surface retirement during cache initialization.
- Made Collection requests carry the requested `projectViewId`; the API validates the destination Collection against that Project rather than the Task's origin Project.
- Made optimistic Collection state match persisted projection semantics: the requested Project appearance receives the destination, while foreign Project appearances become Uncategorized and never receive a foreign Collection ID.
- Threaded the acted-on Project View through Kanban, Collection DnD, linked-Session Collection updates, and the All Projects sidebar context menu.
- Added the required A/C mutation matrix and store integration coverage for explicit workflow, promotion, Collection locality, archive/read-only propagation, current-view override, and failed-mutation rollback.

## Ticket and characterization

- `gh issue view 331 --repo horang-labs/tessera` and `gh issue view 328 --repo horang-labs/tessera` were attempted first as requested. The installed `gh` client failed before rendering either issue because GitHub removed the Projects Classic `repository.issue.projectCards` field.
- Fallback reads succeeded with:
  - `gh api repos/horang-labs/tessera/issues/331 --jq ...`
  - `gh api repos/horang-labs/tessera/issues/328 --jq ...`
  - matching paginated comments endpoints (both returned no comments).
- `graphify query "project-view-workspace-state WorktreeTask workflow collection archive" --budget 2400` oriented the work to `project-view-workspace-state.ts`, `task-store.ts`, `session-store.ts`, and the Project View tests (837-node traversal, 74 shown at the budget).
- `graphify explain "projectViewWorkspaceState"`, `graphify explain "src/stores/task-store.ts"`, and `graphify explain "src/stores/session-store.ts"` confirmed the relevant store/caller relationships before source inspection.
- Current behavior was characterized as follows: explicit workflow updated direct Sessions but not retained Sessions; promotion was duplicated across Task and Session stores; Collection used origin/current inference rather than an explicit acted-on view; archive updated direct Sessions but omitted retained Sessions; failure recovery did not consistently cover every representation.

## `$implement` and `/tdd`

The provider implementation skill was invoked by reading and following `/home/work/.agents/skills/implement/SKILL.md`. It directed the work to use `/tdd` at agreed seams, typecheck regularly, run targeted tests, use `$code-review`, and commit the result.

The `/tdd` skill was invoked at the seam already agreed in #328/#331: the public, stateful Project View workspace-state contract and its A/C fixture.

- Red 1: `npx tsx --test tests/project-view-workspace-state.test.ts` produced 2 passing / 1 failing; the matrix failed with `workspace.applyTaskMutation is not a function`.
- Green 1: after adding the transition contract, the same file produced 3/3 passing.
- Red 2: `npx tsx --test tests/project-view-task-mutation.test.ts` produced 2 passing / 2 failing. Retained workflow remained `todo`, and retained Task-archive state remained unarchived.
- Green 2: after routing stores through the seam, the two workspace/store files produced 8/8 passing.
- Regression red: the six-file targeted run found 59/60 passing; `archiving a task retires the open surfaces of its PTY sessions` failed because the fixture had only the current Task-list mirror. The adapter was extended to include that public cache state, and the focused test passed.
- Review-finding red: the Collection tests produced 6 passing / 3 failing after asserting reload-consistent foreign-view clearing and explicit Project-view override. After the review fixes, they produced 9/9 passing.

No component-private helpers, source strings, or internal call counts were used as the primary test seam.

## Exact final verification

- `npx tsx --test tests/project-view-workspace-state.test.ts tests/project-view-workspace-state-activation.test.ts tests/project-view-task-mutation.test.ts tests/project-view-collection-placement.test.ts tests/task-session-archive.test.ts tests/terminal-session-runtime-state.test.ts`
  - Result: 61 tests, 61 passed, 0 failed; TAP duration 703.697 ms.
- `npx tsc --noEmit`
  - Result: exit 0, no diagnostics.
- `npm run lint`
  - Result: exit 0, 0 errors, 3 warnings. All warnings are pre-existing and outside the changed files: `preview-markdown.tsx` (`no-img-element`), `use-virtual-message-list.ts` (React Compiler incompatible library), and `spawn-cli-runtime.ts` (unused eslint-disable directive).
- `git diff --check`
  - Result: exit 0.
- `graphify update .` after the implementation and again after review fixes
  - Final result: 10,776 nodes, 28,312 edges, 422 communities; `graph.json`, `graph.html`, and `GRAPH_REPORT.md` regenerated under ignored `graphify-out/`.

`npm ci` was required because this isolated worktree initially had no `node_modules`. It installed 1,042 packages. The audit summary reported 46 dependency vulnerabilities (2 low, 13 moderate, 28 high, 3 critical); dependency remediation was outside this ticket.

## `$code-review` invocation and findings

The required skill was invoked from `/home/work/.agents/skills/code-review/SKILL.md` with fixed point `acc8a58a72c9241ede2c5359ed6bd0e1ad7f63e0`, diff command `git diff acc8a58...HEAD`, and commit list containing `f91937d`. Two explicitly authorized read-only agents ran in parallel.

### Standards

No hard violations found. The reviewer found the change focused on #331, aligned with the existing workspace seam, covered by matching tests, and free of path/environment or cross-boundary concerns. No smell-only judgment warranted escalation.

### Spec

The reviewer reported two Collection-locality gaps:

1. Successful optimistic placement could diverge from reload because persistence stores one canonical `collection_id`, while the initial optimistic implementation left a prior foreign-view placement intact. Applied: foreign appearances now become Uncategorized immediately, matching projection after reload, while the requested view retains the destination.
2. The All Projects sidebar context menu did not pass the Project appearance being acted on. Applied: `CollectionContextMenu` now receives `projectViewId={projectId}` and passes it to `updateTask`.

Summary: Standards 0 findings; Spec 2 findings, both addressed at the acceptance boundary. The schema deliberately remains unchanged: one canonical Collection reference is persisted and Project projections mask foreign Collection IDs.

## Commits

- Implementation: `f91937db9cd823a0142d346a2074b04a3448064e`
- Review fixes / final code: `63fa1f165f6bfd1e4b71009cddc21d1fc4d0e8d7`

## What could not be verified

- The full test suite was not run, per the ticket's child-worktree verification rule.
- Browser/E2E visual behavior was not exercised. The acceptance criteria are state-transition and request-semantics changes; no visual claim was made and no UI rendering was changed.
- Isolated Windows Electron was not run because the change does not cross a process, OS, filesystem, or network-topology boundary.
- No screenshot was captured because there is no visual correctness claim in this ticket.

## Deliberately left out

- No database migration or simultaneous independent Collection assignment was added. The current domain schema stores one canonical Task/Session Collection reference; Project Views mask references belonging to another Project. Moving to a Collection in one view therefore makes foreign views Uncategorized rather than copying the foreign Collection.
- No cross-window mutation protocol redesign, global Running/Recent Work work, navigation materialization, notification redesign, or Session-vs-Worktree lifecycle expansion from parent #328 was included; those are outside #331's acceptance criteria.
- No unrelated lint warnings, dependency audit findings, UI styling, or broad store refactor was changed.
- No push or pull request was created.

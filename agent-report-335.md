# Agent report — GitHub issue #335

## What changed and why

Issue #335 required Collection and Kanban drag-and-drop to use the Project View on screen instead of whichever canonical appearance happened to be loaded first.

- Added explicit Project View Task and Session resolution to `ProjectViewWorkspaceState`.
- Routed Collection drag start, single- and multi-item moves, same-Collection reorder, Kanban workflow drops, Chat-column drops, and same-column reorder through the active Project View.
- Scoped optimistic Task and standalone Session Collection changes and rollbacks to the requested Project View, and sent that view to the mutation API for Collection validation and broadcast targeting.
- Scoped Task and Session ordering updates to the active client-side Project View bucket.
- Added A-first/C-active regression coverage for scoped resolution, multi-selection, Collection placement, ordering, and task-linked workflow forwarding.

The implementation deliberately preserves #331's agreed persistence model: one canonical Collection reference is stored, projections mask a Collection that belongs to another Project, and a foreign appearance is therefore Uncategorized rather than holding a second independently persisted Collection assignment.

## Ticket and current-behavior characterization

- `gh issue view 335 --repo horang-labs/tessera` and `gh issue view 328 --repo horang-labs/tessera` were attempted first as requested. The installed `gh` client failed because GitHub removed the Projects Classic `repository.issue.projectCards` field.
- Fallback reads succeeded with `gh api repos/horang-labs/tessera/issues/335`, `gh api repos/horang-labs/tessera/issues/328`, and the #335 comments endpoint (no comments).
- #331 was also read during review-finding validation because #335 is explicitly blocked by it.
- `graphify query "workspace state retained session task snapshot collection placement" --budget 2500` oriented the work to the workspace-state, Collection DnD, Kanban, and store seams (441 nodes traversed, 69 shown).
- `graphify explain` was used for `project-view-workspace-state`, `collection-group-sections`, `kanban-board`, and `board-scope` before source inspection.
- Current behavior was characterized as origin/first-appearance leakage: generic Task/Session lookups could return A while C was visible, multi-selection could skip projected C items, and reorder methods could update every loaded appearance instead of C's cache bucket.

## `$implement` and `/tdd`

The provider implementation skill was invoked by reading and following `/home/work/.agents/skills/implement/SKILL.md`. It supplied the ticket-driven implementation loop, required `/tdd` at agreed seams, targeted verification, `$code-review`, and a commit.

The `/tdd` skill was invoked at the public Project View workspace-state and store mutation seams agreed in #328:

- Red 1: `npx tsx --test tests/project-view-workspace-state.test.ts` produced 5 passing / 1 failing; the new Project-scoped DnD case failed with `workspace.resolveTask is not a function`.
- Green 1: after adding explicit Task/Session resolution, the same file produced 6/6 passing.
- Red 2: `npx tsx --test tests/project-view-task-mutation.test.ts` produced 6 passing / 1 failing; a linked Session Collection move in C was resolved through A, so A received `collection-c-next`.
- Green 2: after threading the visible view through the Session-to-Task bridge, the same file produced 7/7 passing.
- A dedicated public store-seam test, `tests/project-view-dnd.test.ts`, covers C-only Task/Session ordering, standalone Session Collection placement, and task-linked Kanban workflow forwarding. It is 167 lines.

No component-private helper, source-string check, or call-count assertion is the primary regression seam.

## Exact final verification

- `npx tsx --test tests/project-view-dnd.test.ts tests/project-view-workspace-state.test.ts tests/project-view-task-mutation.test.ts tests/project-view-collection-placement.test.ts tests/kanban-board-scope.test.ts tests/kanban-project-projection-render.test.tsx`
  - Result: exit 0; 23 tests, 23 passed, 0 failed; TAP duration 465.526301 ms.
- `node --test tests/kanban-cross-project-dnd-feedback-contract.test.mjs tests/kanban-collection-menu-contract.test.mjs`
  - Result: exit 0; 4 tests, 4 passed, 0 failed; TAP duration 60.035118 ms.
- `npx tsc --noEmit`
  - Result: exit 0, no diagnostics.
- `npm run lint`
  - Result: exit 0, 0 errors, 3 pre-existing warnings outside changed files: `preview-markdown.tsx` (`no-img-element`), `use-virtual-message-list.ts` (React Compiler incompatible library), and `spawn-cli-runtime.ts` (unused eslint-disable directive).
- `git diff --check`
  - Result: exit 0.
- `graphify update .`
  - Result: 10,827 nodes, 28,426 edges, 427 communities; ignored graph artifacts regenerated. Graphify also reported label drift from 432 saved labels to 427 communities and renamed 171 labels by hub; no source failure resulted.

This worktree initially had no `node_modules`. The first `npx tsc --noEmit` therefore invoked the unrelated placeholder `tsc` package and stopped with “This is not the tsc command.” `npm ci` then installed 1,042 packages; its audit summary reported 46 dependency vulnerabilities (2 low, 13 moderate, 28 high, 3 critical). The real TypeScript and lint runs above then passed. Dependency remediation is outside this ticket.

## `$code-review` invocation and findings

The required skill was invoked from `/home/work/.agents/skills/code-review/SKILL.md` with fixed point `4aa7e187387e6000b1925f13b3dba260ee975d57`, `git diff 4aa7e18...HEAD`, and implementation commit `7d3bb11`. Two explicitly authorized read-only agents ran in parallel.

### Standards

No hard standards findings. The reviewer found the diff focused on Project View-scoped DnD, aligned with the workspace-state/store patterns and Project View vocabulary, and free of path/environment violations.

### Spec

The reviewer raised two persistence concerns: canonical `collection_id` writes can mask an existing foreign placement after reload, and canonical `sort_order` writes cannot preserve two independently persisted A/C orders.

Neither was applied. Both require a simultaneous per-view persistence model beyond #335's loaded-view DnD scope and conflict with the already-agreed #328/#331 contract: #328 says no schema change is expected, and #331 deliberately stores one canonical Collection reference while masking it as Uncategorized in foreign Project Views. #335 changes which loaded Project View DnD resolves and mutates; it does not reopen that persistence model. The regression tests preserve the valid foreign-view state for that model and assert A's loaded placement/order remain unchanged by C operations.

Summary: Standards 0 findings; Spec 2 findings reviewed, 0 applicable within the agreed acceptance boundary.

## Commits

- Implementation / final code: `7d3bb11a5064736cc5efe82137427e0a65e83a44` (`fix(project-view): scope DnD to active view (#335)`).
- This report is committed separately after the final code hash so the durable handoff can name it exactly.

## What could not be verified

- The full test suite was not run, per the ticket's child-worktree verification rule.
- No development server or browser/E2E flow was run. The change has no layout or visual correctness claim; the targeted rendered Kanban projection test supplies the relevant React-runtime evidence.
- No screenshot was captured because no visual claim was made.
- Isolated Windows Electron was not run because the change does not cross a process, OS, filesystem, or network boundary.

## Deliberately left out

- No database schema or per-Project View placement/order persistence model was added; that would reopen #328/#331 domain decisions and exceed #335.
- No Collection synchronization/copying between Projects was introduced.
- No cross-window invalidation redesign, lifecycle work, navigation materialization, notification changes, or other parent #328 work was included.
- No unrelated lint warning, dependency audit finding, UI styling, or broad store refactor was changed.
- No full suite, push, or pull request was performed.

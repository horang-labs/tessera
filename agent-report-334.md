# Agent report — GitHub issue #334

## What changed and why

- Extended the Project View workspace-state contract to produce one origin-normalized canonical Session set from direct Project Sessions, retained Sessions, and linked Task Session summaries.
- Routed the global Running badge/panel, All Projects Running count/filter/empty state, global navigation list, and Stop All through that contract so a projected-out running Session appears and is stopped exactly once.
- Made Stop All use the contract's canonical read transition, including unread state that exists only in a loaded Task appearance.
- Fed canonical retained Sessions into the origin Project representation and Recent Work so retained activity/runtime overrides stale Task summaries without changing the established stable running-item ordering.
- Merged canonical runtime state back into origin Task appearances so stale Task snapshots cannot keep an empty All Projects Running section visible.
- Removed the superseded direct-Project-only canonical Running selector.

## Implementation and TDD invocation

The provider implementation skill was invoked by the user's `$implement` request and loaded from `/home/work/.agents/skills/implement/SKILL.md`. It drove issue reading, incremental typechecking/testing, the requested code review, and committing on the current branch.

`/tdd` was loaded from `/home/work/.agents/skills/tdd/SKILL.md`. The already-agreed #328 seams were used:

1. `createProjectViewWorkspaceState` public contract — red/green coverage for canonical direct/retained/Task aggregation, origin placement, deduplicated Stop All, Task-only unread clearing, and stale Task runtime replacement.
2. `buildRecentWorkItems` public builder — red/green coverage for retained canonical activity/runtime overriding a stale Task snapshot while the existing ordering tests remain unchanged.

Observed red failures included `workspace.getCanonicalRunningSessions is not a function`, stale Recent Work title/runtime, missing Task-only read clearing, and stale Task runtime keeping origin Running visibility true. Each slice passed after its minimal implementation.

## Verification commands and measured results

- `node --import tsx --test tests/project-view-workspace-state.test.ts tests/project-view-workspace-state-activation.test.ts tests/recent-work-sort.test.ts tests/origin-project-representation.test.ts tests/session-activation-focus-contract.test.mjs tests/all-projects-board-view-mode.test.ts tests/session-runtime-presentation.test.ts tests/task-session-kind.test.ts tests/active-session-runtime.test.ts tests/terminal-session-runtime-state.test.ts`
  - Final result: 78 tests passed, 0 failed, duration 457 ms.
- `npx tsc --noEmit`
  - Final result: exit 0, no diagnostics.
- `npm run lint`
  - Final result: exit 0, 0 errors, 3 pre-existing warnings in unrelated files (`preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`).
- `git diff --check`
  - Result: exit 0, no whitespace errors.
- `graphify update .`
  - Final result: code graph rebuilt with 10,768 nodes, 28,303 edges, and 436 communities. The graph is above the 5,000-node visualization threshold, so graphify generated its aggregated community view.

The full test suite was deliberately not run because the ticket explicitly delegates that decision to the integrated-wave orchestrator.

## Runtime-specific review

The requested `$code-review` skill was loaded from `/home/work/.agents/skills/code-review/SKILL.md` and invoked against `git diff acc8a58...HEAD` with commit list `21ceae3 fix(project-view): unify global running sessions (#334)`. Its authorized reviewers ran in parallel:

### Standards

No hard documented-standard violations were found. The reviewer confirmed the change remained focused and did not touch the runtime/filesystem/provider rules in `AGENTS.md` or violate `CONTRIBUTING.md`.

### Spec

Two acceptance gaps were found:

1. A stale running Task snapshot could keep an All Projects section visible after its canonical Session stopped.
2. Stop All could skip Task-only unread state when the canonical Session itself was already read.

Both findings were accepted and fixed through new red/green workspace-state tests. The implementation commit was amended afterward.
The same Spec reviewer then rechecked only those two findings against `eac3760` and confirmed both were resolved with no remaining finding.

## What could not be verified

- No browser or Electron acceptance run was performed. The change does not cross a process, OS, filesystem, or network boundary, so the isolated Windows Electron workflow was not applicable. No visual styling changed and this report makes no visual-correctness claim.
- No screenshot was captured because there is no visual-design claim; behavior was verified at the state contract, Recent Work builder, runtime selector, and existing UI integration-contract seams.
- The full suite was not run, per the ticket rule above.

## Commit

Implementation commit: `eac37608d1611fc323b2f59bb30dc200ae7530fe` (`fix(project-view): unify global running sessions (#334)`).

## Deliberately left out

- UI redesign, spacing, icon, and density changes.
- Database/schema changes or historical-row repair.
- Store/framework replacement beyond extending the existing #329 workspace-state boundary.
- Process, provider, filesystem, Windows/WSL, Electron, or network behavior.
- An e2e file or broad unrelated refactor.

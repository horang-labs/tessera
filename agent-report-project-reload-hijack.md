# Issue #351 — Project reload navigation hijack report

Fixed point: `7adffb9a688e1e9b6b5a26dafdb0282e99ffdd8d`

Implementation commit reviewed by this report:

- `424e9e4` — `fix(project-view): preserve board-only reload state (#351)`

The final report commit is intentionally not self-referential; its SHA is recorded in the
agent handoff.

## Outcome

`loadProjects()` now distinguishes initial active-Session hydration from later Project
refreshes with the public `SessionState.didHydrateActiveSession` lifecycle state.

- The first successful Project load still restores a valid `sessionStorage` Session or the
  existing last/current-Project fallback.
- Once that hydration attempt completes, an intentional `activeSessionId === null` remains
  null across passive Project refreshes, including `task_mutated` and `session_mutated`
  background reloads.
- Explicit Session activation, notification navigation, terminal rebound, and active-surface
  reconciliation were not weakened or bypassed.
- The packaged cross-window regression now checks that the source Project and fixture Task
  remain continuously visible after every workflow/title mutation. It does not reselect the
  source Project after mutations begin.

## Exact diagnosis

The suggested general area was correct, but the minimized transition identified the exact
source of the observed old Session:

1. On every successful `loadProjects()`, the old code recomputed saved/fallback activation.
   Its only guard was `!get().activeSessionId`.
2. A board-only action legitimately left `activeSessionId` null.
3. A remote `task_mutated` message called `refreshProjectViewWorkspaceMutation()`, which
   passively called `loadProjects()`.
4. With no `sessionStorage` object in the deterministic Node repro, the storage read failed
   closed and the fallback path selected `session-c` from the current/last Project. This
   isolates fallback reactivation from the alternative stale-saved-Session explanation.
5. The public surface reconciliation boundary then found `session-c` in the hidden Project
   tab snapshot and correctly switched `selectedProjectDir` from `fixture-project` to
   `project-c`. Reconciliation amplified the bad upstream state transition but did not cause
   it independently.

Ranked hypotheses and results:

| Hypothesis | Prediction | Result |
| --- | --- | --- |
| `loadProjects()` reruns startup fallback for any null active Session | Second reload reactivates the old Session with no saved storage | Confirmed |
| Cross-window mutation handling navigates directly | Selected Project changes without active-surface reconciliation | Falsified |
| Project validity reconciliation rejects the fixture | Selected Project changes while active Session remains null | Falsified |
| A saved hidden tab alone forces activation | Activation occurs without the startup restore block | Falsified |

The fix gates only the saved/fallback block. A failed or superseded Project request does not
complete hydration; the winning first successful load does. Project data, retained Sessions,
runtime liveness, turn state, and last-active Project refresh on every call as before.

## RED/GREEN public behavior evidence

The accepted seam is the public store/event/navigation behavior already used by Project View:
`handleIncomingServerMessage(task_mutated)` → `loadProjects()` → Session/Board/Tab/Panel stores
→ `reconcileActiveSessionSurface()`. The test does not call a new private helper.

Baseline before adding the regression:

```sh
npx tsx --test tests/project-view-cross-window-mutation.test.ts tests/project-view-session-lifetime.test.ts
```

Result: 18/18 passed, proving the existing focused suites did not detect the packaged symptom.

RED against `7adffb9` production behavior:

```sh
npx tsx --test --test-name-pattern "passive Task reload" tests/project-view-cross-window-mutation.test.ts
```

Result: 0/1 passed. The exact assertion diff was:

```text
actual:   { activeSessionId: 'session-c', selectedProjectDir: 'project-c' }
expected: { activeSessionId: null,        selectedProjectDir: 'fixture-project' }
```

GREEN after the lifecycle guard:

```sh
npx tsx --test --test-name-pattern "passive Task reload" tests/project-view-cross-window-mutation.test.ts
```

Result: 1/1 passed. The full cross-window mutation file then passed 11/11. A second public
behavior case proves the first hydration prefers a valid saved Session over fallback and marks
hydration complete.

## Verification totals

### Focused Project View matrices

The complete Project View TypeScript/TSX matrix from the prior integration report, including
the two new cases, passed **140/140**, with 0 failures, cancellations, or skips
(`4285.550217 ms`). It includes explicit Project/Session opening, notification/unread
activation, terminal rebound and reserved-destination behavior, hidden surface
reconciliation, tab lifetime, Project A/C mutation, archive/restore, and DnD coverage.

```sh
npx tsx --test tests/active-workspace-session.test.ts tests/project-view-workspace-state.test.ts tests/project-view-workspace-state-activation.test.ts tests/project-view-task-mutation.test.ts tests/project-view-collection-placement.test.ts tests/project-view-session-lifetime.test.ts tests/project-view-cross-window-mutation.test.ts tests/project-view-dnd.test.ts tests/adaptive-linked-worktree-navigation.test.tsx tests/project-view-open-session.test.ts tests/project-view-tab-state.test.ts tests/project-view-unread-selector.test.tsx tests/recent-work-sort.test.ts tests/origin-project-representation.test.ts tests/kanban-board-scope.test.ts tests/kanban-project-projection-render.test.tsx tests/task-session-archive.test.ts tests/session-archive-client.test.ts tests/terminal-session-runtime-state.test.ts tests/project-view-session-scope.test.ts tests/project-view-worktree-scope.test.ts tests/project-view-membership-migration.test.ts
```

The focused Project View source/navigation contract matrix passed **38/38**, with 0 failures,
cancellations, or skips (`341.594969 ms`). In particular:

- explicit Session activation selects tab, panel, and composer focus;
- Session-open surfaces activate the located panel;
- List, Kanban, and notification navigation materialize before opening;
- notification toasts select a surface before history loading;
- passive panel history loading never requests activation.

```sh
npx tsx --test tests/board-popout-live-sync-contract.test.mjs tests/kanban-collection-menu-contract.test.mjs tests/kanban-cross-project-dnd-feedback-contract.test.mjs tests/kanban-session-peek-contract.test.mjs tests/session-activation-focus-contract.test.mjs tests/tab-panel-persistence-contract.test.mjs tests/unread-notification-priority-contract.test.mjs tests/board-state-persistence-contract.test.mjs
```

### Natural-exit repository suites

No force-exit flag was used.

```sh
npm run test:unit
npm run test:contracts
```

- Unit TS/TSX: **1,632 tests; 1,630 pass; 0 fail; 0 cancelled; 2 existing skips**;
  `30419.875293 ms`, 30.69 s wall time.
- MJS contracts: **354 tests; 354 pass; 0 fail; 0 cancelled; 0 skipped**;
  `3085.60806 ms`, 3.51 s wall time.
- No owned test runner remained after natural completion. An unrelated suite in sibling
  worktree `feature/0812-t349` was observed and deliberately left untouched.

### Static and production checks

```sh
git diff --check
npx tsc --noEmit
npm run lint
npm run build
graphify update .
```

- Diff check: clean.
- TypeScript: 0 errors.
- Lint: 0 errors and 3 pre-existing warnings in `preview-markdown.tsx`,
  `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`; no changed-file warning.
- Production Next.js build: successful; webpack compilation completed in 67 s and the full
  command in 93.58 s.
- Graphify incremental update: successful; **10,986 nodes, 28,916 edges, 443 communities**.
  The generated graph artifacts are gitignored. Graphify reported that community labels can
  be refreshed separately; issue #351 required the graph update, not an LLM relabel pass.

## Parallel code review

The `code-review` skill reviewed `git diff 7adffb9...HEAD` at commit `424e9e4`. Standards and
Spec reviewers ran independently and in parallel.

### Standards

Zero findings: no hard violation of `AGENTS.md`, `CONTRIBUTING.md`, or
`docs/agents/domain.md`, and no judgement-call smell from the required baseline.

### Spec

Zero actionable code findings. The reviewer confirmed saved/fallback hydration, stable
post-hydration null, unchanged explicit navigation/reconciliation, public behavior coverage,
continuous Electron source-Project assertions, and absence of scope creep. The reviewer noted
only that verification and this report were pending; both are now complete.

Summary: **Standards 0 findings; Spec 0 actionable findings**. No review fix was required.

## Deliberate exclusions

- No packaged Electron app was built or launched. The root orchestrator owns final isolated
  Windows Electron QA in the real packaged Windows server → WSL CLI topology.
- The packaged Electron script was strengthened but not executed here for the same reason.
- `reconcileActiveSessionSurface`, explicit Session open/activation, notification navigation,
  terminal rebound, and Project validity behavior were not changed; their existing focused
  matrices provide regression evidence.
- No dev web server/browser acceptance was run: the deterministic public state/event seam
  reproduces the client-state transition, while only the orchestrator-owned packaged topology
  can provide the remaining environment-specific evidence.
- No schema, API, path/environment, process-boundary, or Electron packaging behavior changed.
- No GitHub issue, comment, label, PR, or remote branch was mutated, and nothing was pushed.

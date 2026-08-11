# Agent Report — GitHub Issue #330

## What changed and why

- Added one Project View open-surface lifetime boundary that discovers canonical Session
  references across materialized panels, inactive Project/global tab snapshots, Kanban Peek,
  and Peek file sidecars.
- Changed Project refresh retention to consume that boundary, so switching from Project A to
  C no longer evicts a Session that A can restore from its inactive tab snapshot.
- Extended tab retirement to update every live and snapshotted occurrence. A single-panel tab
  is removed; a matching panel in a split snapshot is cleared while the remaining layout is
  preserved. Stop, archive, delete, Task archive, and terminal retirement use the shared path,
  which also retires matching Peek state.
- Made workspace-file and memory-file special tabs retain and retire with their source Session.
  Materialized tab IDs now shadow their saved copies during discovery, preventing a stale
  snapshot from extending retention after the live panel changes.
- Included retained terminal Sessions in reconnect runtime-snapshot retirement while keeping
  optimistic `temp-` and pending-rebound protections. A Task-projection-only GUI Session now
  also retires its surface on stop.

## Implementation skill and TDD seams

- Invoked `$implement` from `/home/work/.agents/skills/implement/SKILL.md`, treating GitHub
  issue #330 as the ticket and #328 as its agreed design context.
- Loaded `/tdd` and used the pre-agreed public seams from #328/#330:
  - Project tab `switchProject`, Session `loadProjects`, and canonical `getSession` resolution;
  - the Project View workspace-state open-session contract;
  - public stop/archive/delete WebSocket and store lifecycle actions;
  - terminal reconnect runtime snapshots plus pending rebound reservations;
  - public workspace-file special-tab ownership through the source Session.
- The first runnable RED command passed only the pending-rebound protection case and failed
  the other 6/7 cases: inactive snapshot refresh, Peek-only retention, stop, archive, delete,
  and retained-terminal reconnect retirement. The first attempt before `npm ci` stopped at a
  missing `uuid` dependency and was not counted as product evidence.
- Vertical slices were run as RED → GREEN: refresh/open-surface discovery, lifecycle
  retirement, then reconnect retirement. Review findings added regression cases for stale
  materialized snapshot copies, special file tabs, and Task-projection-only GUI stop.

## Exact commands and measured results

- `gh issue view 330 --repo horang-labs/tessera --json number,title,body,labels,state,url,comments`
  — issue #330 read successfully. The bare command first failed because GitHub's default
  response still requested deprecated Projects Classic data.
- `gh issue view 328 --repo horang-labs/tessera --json number,title,body,labels,state,url,comments`
  — agreed parent design read successfully.
- `npm ci` — 1,042 packages installed from the lockfile; package manifests were unchanged.
- `npx tsx --test tests/project-view-session-lifetime.test.ts`
  - RED after dependencies were installed: 1 passed, 6 failed;
  - initial GREEN: 7 passed, 0 failed.
- Final post-review targeted command:
  `npx tsx --test tests/project-view-session-lifetime.test.ts tests/project-view-open-session.test.ts tests/project-view-tab-state.test.ts tests/terminal-session-runtime-state.test.ts tests/workspace-tree-operations-contract.test.mjs tests/memory-contract.test.mjs`
  — 106 passed, 0 failed.
- Broader pre-review lifecycle command:
  `npx tsx --test tests/project-view-session-lifetime.test.ts tests/project-view-workspace-state.test.ts tests/project-view-workspace-state-activation.test.ts tests/project-view-open-session.test.ts tests/project-view-tab-state.test.ts tests/terminal-session-runtime-state.test.ts tests/terminal-preview-surface-lifecycle.test.ts tests/task-session-archive.test.ts tests/codex-session-lifecycle-sync.test.ts tests/session-activation-focus-contract.test.mjs`
  — 87 passed, 0 failed.
- `npx tsc --noEmit` — passed with exit code 0 before and after review fixes.
- `npm run lint` — passed with exit code 0 and no warnings before and after review fixes.
- `git diff --check` — passed.
- `graphify update .` — final graph update completed with 10,784 nodes, 28,343 edges,
  and 433 communities. Graph artifacts remain ignored.

## What could not be verified

- No development-browser or screenshot verification was run. This ticket changes client state
  retention and lifecycle behavior without changing rendered visuals; the report makes no
  visual correctness claim. The public state/lifecycle behavior was exercised deterministically.
- No isolated Windows Electron run was needed because the implementation does not cross a
  process, OS, filesystem, or network boundary.

## Code review

- Invoked `$code-review` exactly as provided against fixed point
  `acc8a58a72c9241ede2c5359ed6bd0e1ad7f63e0`, using
  `git diff acc8a58a72c9241ede2c5359ed6bd0e1ad7f63e0...HEAD` and commit list
  `cb5a6b3 fix(project-view): preserve snapshotted sessions (#330)`.
- The skill ran the Standards and Spec axes in parallel read-only sub-agents. The reviewed
  preliminary commit was amended after every valid finding was applied.

## Standards

- Hard violations: none. The reviewer found no conflict with `AGENTS.md`,
  `CONTRIBUTING.md`, or `docs/agents/domain.md`.
- One judgement call: possible Duplicated Code in `src/stores/tab-store.ts`, where live and
  snapshotted retirement repeated the same panel matching and whole-tab classification. This
  was valid and applied by extracting `getSessionRetirement` while leaving the distinct live
  and snapshot mutations separate.

## Spec

- “A retained Session is evicted only after no materialized, snapshotted, or Peek surface
  references it.” A materialized tab's stale saved copy could over-retain its former Session.
  Applied: discovery now skips snapshots whose tab ID is currently materialized, with a
  regression test.
- “Project refreshes must retain every Session still referenced by either form” and lifecycle
  retirement must update/remove both forms. Workspace-file and memory-file tabs used encoded
  special IDs rather than their source Session IDs. Applied: discovery and retirement now map
  those surfaces to their source Session, with a snapshotted-file regression test.
- “Stop, archive, delete, and terminal retirement update or remove matching materialized and
  snapshotted surfaces.” A GUI Session present only in a Task projection had no direct Session
  object from which to infer kind, so stop did not retire its surface. Applied: stop falls back
  to the public Task lookup and the existing Task-only regression now asserts retirement.

Summary: Standards 1 finding (worst: judgement-call duplicated matching logic, applied);
Spec 3 findings (worst: special file/memory surfaces could lose their canonical source Session,
applied). No findings remain open.

## Commit

- Final implementation commit: `03ef935b670d85aa2f2683f55477ecb30cedcbb8`.
- This report is committed separately because a commit cannot record its own final hash.

## Deliberately left out

- The full test suite was not run, per the child-worktree/orchestrated-wave verification rule.
- No push, pull request, GitHub issue mutation, database/schema change, UI redesign, or
  unrelated Project View work from parent #328.
- No broad store rewrite; existing stores remain behind the new open-surface lifetime boundary.

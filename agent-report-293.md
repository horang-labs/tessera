# Agent Report — GitHub Issue #293

## Outcome

Implemented issue #293 from fixed point `0c97284a0878b42c48a2550b3c31c9765d15206a`.
Session and Worktree lifecycles are now separate: Session archive/delete never removes a
checkout, while every physical Worktree deletion is an explicit canonical-ID operation,
guarded against every visible Project Worktree view. Canonical Task, Session, and Worktree
records survive physical deletion and external absence. Project ownership-transfer UI and
API are unavailable.

Implementation commits:

- `e38769182f83b615ac299c392a085eca22de43d7` — core lifecycle implementation
- `ef9c19fdbacde3165e68c5d471eb756bed50f958` — initial Standards/Spec review fixes
- `486f96848fe040b718dd2c0513a1c19261cfec6f` — final Standards naming fix

## Acceptance-criterion mapping

| Acceptance criterion | Implementation and evidence |
| --- | --- |
| Session delete/archive/restore mutates one canonical Session in every Project projection | `session-orchestrator.ts` deletes only the Session/history; `linked-worktree-independent-project.test.ts` asserts archive disappearance, restore reappearance, and delete disappearance in both origin and imported-Worktree projections. |
| Final Session archive/delete leaves a zero-Session Worktree Task and checkout | `parent-worktree-authority.test.ts` exercises final child archive/restore/delete and final standalone delete; both checkouts remain and the Task remains with zero Sessions. |
| Worktree deletion is explicit and canonical-ID based | UI and archive actions call `DELETE /api/worktrees/{worktreeId}`. The old Task-ID Worktree endpoint and `DELETE /api/tasks/{taskId}` are unavailable. Active deletion archives records before removing the checkout. |
| Deletion is blocked for every visible Project Worktree | `getVisibleProjectWorktreeViews(worktreeId)` guards by canonical identity at API entry and again immediately before Git/fallback deletion. `worktree-lifecycle-guard.test.ts` and headful QA verify the block. |
| Block explains Project removal/hiding | Single and bulk errors name the visible Project and say it must be removed or hidden; bulk UI now preserves detailed service errors. |
| Removing/hiding Project does not delete canonical data | Lifecycle integration test hides the guarding Project, asserts Task/Session persistence, then performs a separate explicit physical deletion. |
| External absence preserves database records | Integration test removes only an isolated temporary Git worktree externally, observes `missing`, rejects explicit deletion as unavailable, and retains Task/Session/Worktree rows without a deletion timestamp. |
| Move to Project removed from all listed surfaces | Dialog, Session store action, direct/linked/Task/legacy handlers, and Kanban handlers were removed. The `/api/sessions/[id]/move` route is absent. |
| Ownership-only API unavailable | The move route is deleted and the narrow source contract confirms it cannot be called. No replacement move/reparent flow was added. |
| Lifecycle integration coverage | Cross-projection mutation, final-Session preservation, active/archived canonical deletion, visible-root guard, Project hide preservation, and external absence are covered with real temporary SQLite/Git fixtures. |

## Files and architecture changed

- `src/lib/session/session-orchestrator.ts`: removed implicit last-Session managed Worktree cleanup.
- `src/lib/archive/archive-service.ts`: centralized canonical Worktree deletion, active-Task
  archival/compensation, all-Session locking, root guards, and missing-checkout preservation.
- `src/lib/db/worktrees.ts`: added canonical-ID Project-view, Task, and Session queries plus
  deletion metadata fan-out without removing the Worktree registry row.
- `src/app/api/worktrees/[id]/route.ts`: canonical physical-delete endpoint with mutation
  broadcasts. Task-ID and archived-Task-ID physical-delete routes are unavailable.
- Session/task archive and settings routes plus Archive/Worktree settings UI: removed implicit
  retention cleanup triggers and user-facing auto-delete controls. Persisted legacy settings
  fields remain migration-compatible but no longer cause archive actions to delete checkouts.
- Chat/Kanban/sidebar/session store: removed Project reassignment behavior and UI.
- Worktree deletion dialog/store: explicitly says the checkout is removed while archived
  Worktree and Session records are kept; the store contract is `deleteWorktree(...): boolean`.
- Tests: extended the canonical projection fixture and parent-Worktree tests; added isolated
  lifecycle guard and ownership/API surface contracts. Every new/extended end-to-end-style
  test file is under 200 lines (153, 193, and 33 lines respectively).

## Verification commands and measured results

Mandatory intake/orientation:

```text
gh issue view 293 --repo horang-labs/tessera --json number,title,body,url,state
git rev-parse HEAD                         # initially fixed point exactly
git merge-base HEAD 0c97284a...            # 0c97284a...
graphify reflect --if-stale
graphify query "session worktree archive delete identity canonical"
graphify explain "src/lib/archive/archive-service.ts"
graphify explain "removeArchivedTaskWorktree"
graphify explain "CanonicalWorktreePath"
graphify explain "src/lib/db/sessions.ts"
graphify explain "src/lib/db/projects.ts"
graphify update .                          # final: no topology changes pending
```

Focused tests, run as isolated Node processes:

```text
node --import tsx --test tests/linked-worktree-independent-project.test.ts
# 1 passed, 0 failed

node --import tsx --test tests/worktree-lifecycle-guard.test.ts
# 3 passed, 0 failed

node --import tsx --test tests/task-session-archive.test.ts
# 8 passed, 0 failed

node --import tsx --test tests/worktree-identity-persistence.test.ts
# 3 passed, 0 failed

node --import tsx --test tests/project-worktree-root.test.ts
# 4 passed, 0 failed

node --import tsx --test --test-name-pattern='deleting the last child|deleting the final standalone' tests/parent-worktree-authority.test.ts
# 2 passed, 0 failed

node --test tests/project-ownership-transfer-contract.test.mjs
# 1 passed, 0 failed
```

Total issue-focused assertions: 22 tests passed, 0 failed.

Static verification:

```text
npx next typegen
# generated route types successfully after route relocation

npx tsc --noEmit
# exit 0, no diagnostics

npm run lint
# exit 0; 0 errors, 3 warnings in unchanged files:
# preview-markdown.tsx, use-virtual-message-list.ts, spawn-cli-runtime.ts

git diff --check
# exit 0
```

The repository-wide full suite was intentionally not run, per ticket instruction. One broader
focused-file probe was run once:

```text
node --import tsx --test tests/parent-worktree-authority.test.ts
# 8 passed, 1 failed
```

The failing static-contract assertion requires every listed runtime consumer, including
`src/lib/ws/server-message-routing.ts`, to contain `getSessionWorktreeContext`. That source lacks
the string at fixed point `0c97284a...` and is unchanged by this ticket; the two issue-relevant
tests in that file pass independently as recorded above.

## Browser / Electron evidence

Procedure: inherited Tessera variables were checked and stripped; the server used only
`/tmp/tessera-293-ui-x3MBsj/data/tessera-dev.db` on port 3293. All Git repositories and
worktrees were isolated under `/tmp/tessera-293-ui-x3MBsj`. Chromium ran headful through a
named persistent Playwright session on `DISPLAY=:99`; WSLg was not used.

Evidence directory: `/home/work/tmp/tessera-293-evidence/`

- `01-project-session-lifecycle.png` — isolated Project shows direct Session and linked Worktree.
- `02-session-menu-no-project-transfer.png` — Session menu contains no Move to Project action.
- `03-visible-project-worktree-delete-blocked.png` — single Worktree deletion names
  `T293 Guard Project` and directs removal/hiding; checkout remained present.
- `04-session-delete-is-record-only.png` — Session delete dialog contains no checkout deletion warning.
- `05-active-worktree-delete-preserves-records.png` — active Worktree dialog states the checkout
  is removed while the child Session and archived records are kept.
- `06-active-worktree-record-retained.png` — after canonical API success, checkout is absent and
  the Archive shows `Active Worktree` with `deleted` status.
- `07-bulk-delete-actionable-root-guard.png` — bulk failure displays the Project name and exact
  “removed or hidden” remediation; guarded checkout remained present.

Observed server evidence included `DELETE /api/worktrees/wt_... 200` for the isolated active
Worktree and a canonical guard error for the bulk operation. Windows Electron was not used:
this behavior does not cross a process/OS/filesystem/network boundary, so the required WSL
headful dev-browser topology was sufficient.

## Review findings

### Initial Standards

- No documented-standard violations.
- One judgement-call Duplicated Code smell for bulk versus retention deletion loops. Rejected:
  the loop shape predates the ticket, eligibility and entry contracts differ, and extracting a
  policy executor would be an unrequested abstraction contrary to `CONTRIBUTING.md`'s preference
  for existing local patterns and focused changes.

### Initial Spec

- High: active Worktree Task deletion still targeted Task identity and deleted records. Applied:
  canonical `/api/worktrees/{id}` now archives/preserves records and performs guarded checkout deletion.
- Medium: bulk root-guard details were discarded. Applied: dashboard displays each unique detailed error.
- Low: restore was called but not asserted in both projections. Applied: both reappearance assertions added.

### Final Standards / Spec

- Spec re-review: no findings; all three initial findings confirmed resolved.
- Standards re-review: one Mysterious Name finding for the legacy `deleteTask` /
  `deletedSessionCount` store contract. Applied in `486f968`: renamed to `deleteWorktree` with a
  boolean success contract and updated all callers.
- Standards follow-up: no findings. Earlier duplication suggestion remained correctly suppressed.

## What could not be verified

- The repository-wide full suite was not run because the ticket explicitly assigns that decision
  to the orchestrator.
- Windows Electron topology was not exercised because no changed behavior crosses that boundary.
- Provider model/skill probes in the isolated dev browser logged unrelated native-environment
  errors; the lifecycle API/UI flows, database, and Git evidence completed successfully.

## Deliberately excluded scope

- No Move to Project replacement, reparenting workflow, or Project-local Session ownership model.
- No recovery wizard, watcher, or reconciliation state machine for externally missing Worktrees.
- No unrelated lint-warning cleanup, baseline static-contract repair, or broad archive/retention refactor.
- No push, PR, user database, user Worktree, branch, or Session mutation.

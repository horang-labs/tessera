# Agent Report — GitHub Issue #329

## What changed and why

- Added `ProjectViewWorkspaceState`, a public client boundary that resolves one canonical
  Session across direct Project Session pages, retained open Sessions, and loaded Worktree
  Task Session summaries. It separately projects Project-local Collection placement and
  validates known Collection IDs for the requested Project View.
- Added a live adapter beside the existing Zustand stores. Existing store APIs remain in
  place; the adapter coordinates canonical unread clearing, Task-summary mirroring,
  notification reads, and the server read acknowledgement.
- Routed successful Session panel activation and already-visible active pane reconciliation
  through the idempotent read transition.
- Added a shared React unread selector that combines canonical Session state, Task summary
  state, and notification state. Tab, List/child row, Task row, Kanban, Collection header,
  and panel consumers now use this common rule instead of scanning `projects` independently.
- Extended `TaskSession` summaries with optional live `unreadCount` and mirrored increments /
  clears across every loaded Project Task appearance. This keeps old store callers working
  while consumers migrate to the new contract.

## Implementation skill and TDD seams

- Invoked the provider implementation skill from
  `/home/work/.agents/skills/implement/SKILL.md` for issue #329, using GitHub issue #328 as
  the agreed parent design.
- Loaded `/tdd` and used the seam pre-agreed by #328: the public stateful Project View
  workspace-state contract, not private helpers or store layout.
- Red/green seams:
  - `createProjectViewWorkspaceState`: the first run failed with
    `ERR_MODULE_NOT_FOUND`; after implementation, direct/retained/Task-summary resolution,
    canonical deduplication, A/C placement, and idempotent read behavior passed.
  - `activateSessionPanel`: the retained unread regression failed with `1 !== 0`; after the
    client adapter was connected, canonical unread, Task summaries, notifications, and one
    acknowledgement converged.
  - shared visible-surface unread selection: the first run failed because the module did not
    exist. The retained/notification rule was then added and adopted by all ticket-named
    surfaces. A server-render attempt exposed that Zustand intentionally serves
    `getInitialState()` as its SSR snapshot, so the test was kept at the exported pure public
    selector seam while the live store transition remains covered by the activation test.

## Commands and measured results

- `gh issue view 329 --repo horang-labs/tessera --json number,title,body,comments,labels`
  — issue #329 read successfully.
- `gh issue view 328 --repo horang-labs/tessera --json number,title,body,comments,labels`
  — parent design #328 read successfully.
- `npm ci` — 1,042 packages installed from the lockfile; package files were unchanged.
- `npx tsx --test tests/project-view-workspace-state.test.ts`
  - red: missing `project-view-workspace-state` module;
  - green: 2/2 tests passed.
- `npx tsx --test tests/project-view-workspace-state-activation.test.ts`
  - red: retained unread remained `1` after activation;
  - green: activation regression passed.
- `npx tsx --test tests/project-view-unread-selector.test.tsx`
  - red: missing shared unread-selector module;
  - green: notification-only unread contract passed.
- Final targeted command:
  `npx tsx --test tests/board-popout-live-sync-contract.test.mjs tests/session-activation-focus-contract.test.mjs tests/unread-notification-priority-contract.test.mjs tests/adaptive-linked-worktree-navigation.test.tsx tests/kanban-project-projection-render.test.tsx tests/collection-status-indicator.test.ts tests/project-view-open-session.test.ts tests/project-view-tab-state.test.ts tests/project-view-task-mutation.test.ts tests/project-view-unread-selector.test.tsx tests/project-view-workspace-state-activation.test.ts tests/project-view-workspace-state.test.ts`
  — 45/45 tests passed, 0 failed.
- `npx tsc --noEmit` — passed with exit code 0.
- `npm run lint` — passed with 0 errors and 3 unrelated existing warnings in
  `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`.
- `graphify update .` — final graph update completed with 10,761 nodes, 28,285 edges, and
  417 communities. Graph outputs are ignored workspace artifacts.
- `git diff --check` — passed before the implementation commit.

## Runtime/UI verification not completed

- `xdpyinfo -display :99` reported `DISPLAY_99_UNAVAILABLE`. Per repository rules, no WSLg
  fallback was used. The development server was not started, and no browser screenshot was
  captured. Visual indicator color was therefore not claimed from runtime evidence; state,
  rendered component regressions, and accessible/status contracts were verified by the
  targeted tests above.
- No Windows Electron run was needed because the change does not cross a process, OS,
  filesystem, or network boundary.

## Code review

- Invoked `$code-review` exactly against fixed point
  `501aa399b51be7e928ba3d34fed50a69efb2c0a5` using
  `git diff 501aa399b51be7e928ba3d34fed50a69efb2c0a5...HEAD` and commit list
  `5041652 feat(project-view): add canonical workspace state contract (#329)`.
- The skill ran its Standards and Spec reviewers in parallel, read-only sub-agents.
- Standards: 0 findings; no hard documented repository-standard violations.
- Spec: 2 findings:
  - notification-only unread was not yet shared by every ticket-named visible surface;
  - visible pane activation still gated on numeric `unreadCount` and could miss a
    notification-only unread transition.
- Both findings were valid and applied. The implementation commit was amended after the
  fixes and all final checks were rerun.

## Commits

- Reviewed implementation commit:
  `30b34abb975e4cd9fe06c0e7267012d16f126d17`
- This report is committed separately as the durable handoff because a commit cannot embed
  its own final hash in its contents.

## Deliberately left out

- No full test suite was run, per the child-worktree verification rule.
- No push, pull request, GitHub issue mutation, schema migration, or Electron packaging.
- Parent #328 follow-on scope such as global Running aggregation, Recent Work, navigation
  materialization, DnD, archive/restore, cross-window convergence, and terminal retirement
  was not implemented unless directly required by #329's acceptance criteria.

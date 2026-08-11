# Agent Report — GitHub Issue #336

## What changed and why

Issue #336 requires Session lifecycle actions to stop borrowing Worktree Task lifecycle semantics.
The previous client routed a task-owned Session's chat-header archive and `/archive` command to
`toggleTaskArchive`, and the one-Session composite row's quick action also archived the Task.

The implementation now:

- routes composite-row, chat-header, sidebar child, and `/archive` actions through the canonical
  Session ID;
- keeps the zero-Session Worktree Task row after its last Session is archived;
- labels the remaining parent action `Archive worktree task` and gives Session and Task actions
  distinct test IDs;
- keeps direct-Session unarchive behavior, while not exposing an unsupported task-owned Session
  unarchive in the chat header;
- adds a focused 180-line browser acceptance test using an isolated database, real setup login,
  a real managed Worktree, and headless Chromium.

No server/database lifecycle change was needed: the existing Session archive endpoint, workspace
state mutation boundary, cross-window mutation handling, restore path, and surface-retirement code
already implement the canonical archive/restore transition once the UI selects the correct entity.

## Implementation skill and TDD seams

The provider's `$implement` skill was invoked by loading
`/home/work/.agents/skills/implement/SKILL.md` and treating issue #336 as its supplied ticket. Its
`/tdd` requirement ran through the pre-agreed #328 public seams:

1. **Rendered adaptive Worktree row seam** — added a zero/one/many markup contract. Red failed
   because the standalone action still said `Archive task`; green proved composite uses the Session
   action while standalone/expanded parents retain the Worktree Task action.
2. **Canonical Session client-action seam** — added `requestSessionArchive`. Red failed with
   `MODULE_NOT_FOUND`; green proved Session-level entry points preserve `task-owned-session` as the
   canonical ID and request `archived=true`.

The browser acceptance then exercised the composite quick action, chat-header action, `/archive`,
zero-Session persistence, and explicit Worktree Task archive as one vertical lifecycle flow.

## Exact commands and measured results

- `gh issue view 336 --repo horang-labs/tessera` and `gh issue view 328 --repo horang-labs/tessera`
  were attempted first; the default GraphQL projection emitted GitHub's Projects Classic
  deprecation error. Re-reading both with `--json number,title,body,comments,labels,state,assignees,url`
  succeeded.
- `node --import tsx --test tests/adaptive-linked-worktree-navigation.test.tsx`
  - red: 8 passed, 1 failed on the archive identity/label assertion;
  - green: 9 passed, 0 failed.
- `node --import tsx --test tests/session-archive-client.test.ts`
  - red: module not found;
  - green: 1 passed, 0 failed.
- Targeted lifecycle command covering six files (`session-archive-client`, adaptive Worktree,
  task-session archive, workspace state, cross-window mutation, and Session lifetime):
  **44 passed, 0 failed** in 1.625 s.
- Post-review targeted command covering five files: **36 passed, 0 failed** in 0.450 s.
- `node tests/session-worktree-archive.e2e.mjs`
  - first setup attempt correctly failed with `PROJECT_ENVIRONMENT_MISMATCH` because the isolated
    server defaulted to native for a WSL path;
  - after explicitly setting `agentEnvironment: wsl`, it passed twice (before and after review fix);
  - observed three Session PATCHes to `/api/sessions/<id>/archive`, one explicit Task PATCH to
    `/api/archive/tasks/<id>`, and a retained standalone Worktree row after each final-Session archive.
- `npx tsc --noEmit`: passed with no diagnostics before and after review.
- `npm run lint`: passed with 0 errors. The first run reported three unrelated existing warnings;
  the final run completed without diagnostics.
- `node --check tests/session-worktree-archive.e2e.mjs`: passed.
- `git diff --check`: passed.
- `graphify update .`: completed after implementation (10,909 nodes / 28,613 edges), then completed
  again after the review fix with no topology changes.

Browser screenshots were captured and visually inspected:

- `.tmp/issue-336-evidence/01-composite-session-action.png` (79,114 bytes)
- `.tmp/issue-336-evidence/02-zero-session-worktree.png` (56,628 bytes)
- `.tmp/issue-336-evidence/03-explicit-worktree-task-action.png` (89,312 bytes)

## Runtime-specific review

The requested `$code-review` skill was loaded from
`/home/work/.agents/skills/code-review/SKILL.md`. Fixed point `b656df9` resolved successfully;
the reviewed command was `git diff b656df9...HEAD`, with commit list initially containing
`ab9d95d fix(project-view): separate session and task archive (#336)`. The skill's two read-only
reviewers ran in parallel as `/root/review_standards_336` and `/root/review_spec_336`.

### Standards

No hard documented-standards findings. The reviewer found the change focused and consistent with
existing store/E2E patterns. It noted that command and screenshot evidence was not yet inferable
from the implementation diff; this report now records both.

### Spec

One P1 acceptance finding: enabling task-owned Session **unarchive** in the header would call the
generic local `toggleArchive(false)` path, which does not repopulate Task Session summaries in the
initiating window, while the echoed mutation is ignored. The E2E restore reload masked that path.

Applied resolution: `TaskContextMenu` now permits archive and unarchive callbacks independently;
the task-owned Session header exposes only the required archive action. Direct Sessions retain their
existing unarchive callback, and task-owned Session restore remains on Archive Dashboard's existing
workspace-state restore path. Targeted tests, typecheck, lint, and the browser acceptance all passed
again afterward.

Review summary: **Standards 0 findings (no worst issue); Spec 1 finding (source-window task-owned
header unarchive density), resolved.**

## What could not be verified

- The full test suite was not run, per the ticket's child-worktree verification rule.
- Windows Electron was not run because this change is client UI/state routing and does not cross a
  process, OS, filesystem, or network-topology boundary.
- Headful Linux/WSL verification was not run because the designated isolated `DISPLAY=:99` was
  unavailable. Verification used headless Chromium and did not fall back to user-visible WSLg.

## Deliberately left out

- No archive database schema, server lifecycle, retention, or Worktree deletion changes.
- No Project View density redesign, icon redesign, or unrelated Kanban/archive polish.
- No change to Worktree Task archive semantics beyond making its existing action explicit.
- No push, PR creation, issue mutation, or full-suite run.

## Commit

Implementation code/tests commit: `efcb0d5d11c58a4e734be4159ab2034d0af9661b`.
This report is committed separately as the durable handoff.

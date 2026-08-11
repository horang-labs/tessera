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
- adds a focused 188-line browser acceptance test using an isolated database, real setup login,
  a real managed Worktree, and headless Chromium;
- synchronizes every UI archive action with its successful Session archive response before the
  test restores that Session, so an optimistic zero-Session render cannot race a later archive
  commit and overwrite the restore.

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
The verification follow-up used the same E2E as the red/green seam: it reproduced the archive versus
restore ordering race, then proved the response-synchronized flow stable without changing production
behavior.

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
  **44 passed, 0 failed** initially. The exact follow-up command was
  `node --import tsx --test tests/session-archive-client.test.ts tests/adaptive-linked-worktree-navigation.test.tsx tests/task-session-archive.test.ts tests/project-view-workspace-state.test.ts tests/project-view-cross-window-mutation.test.ts tests/project-view-session-lifetime.test.ts`:
  **44 passed, 0 failed** in 679 ms.
- Post-review targeted command covering five files: **36 passed, 0 failed** in 0.450 s.
- `node tests/session-worktree-archive.e2e.mjs`
  - first setup attempt correctly failed with `PROJECT_ENVIRONMENT_MISMATCH` because the isolated
    server defaulted to native for a WSL path;
  - after explicitly setting `agentEnvironment: wsl`, it passed twice (before and after review fix);
  - observed three Session PATCHes to `/api/sessions/<id>/archive`, one explicit Task PATCH to
    `/api/archive/tasks/<id>`, and a retained standalone Worktree row after each final-Session archive.
  - independent orchestration later failed deterministically after the `/archive` case at the old
    line 128: actual density `standalone`, expected `composite`;
  - the exact command first passed locally, but
    `for run_id in 1 2 3 4 5 6; do echo "RUN ${run_id}"; node tests/session-worktree-archive.e2e.mjs || exit 1; done`
    reproduced the same failure on run 1;
  - temporary tagged diagnostics showed that after the third restore returned, the authoritative
    `/api/tasks` response still had zero matching Sessions and the UI did not converge within five
    seconds. This disproved a DOM-readiness-only theory and identified a late slash-command archive
    request overwriting the restore. The diagnostics were removed;
  - after awaiting each archive PATCH response, the exact stability loop
    `for run_id in 1 2 3 4 5 6 7 8 9 10; do echo "RUN ${run_id}"; node tests/session-worktree-archive.e2e.mjs || exit 1; done`
    passed **10/10 runs**, exercising 30 successful Session archive/restore cycles.
- `npx tsc --noEmit`: passed with no diagnostics after the follow-up fix.
- `npm run lint`: passed with **0 errors and 3 pre-existing warnings** in
  `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`; none are in the
  issue #336 diff.
- `node --check tests/session-worktree-archive.e2e.mjs`: passed.
- `git diff --check`: passed.
- `graphify update .`: completed after implementation and review, then again after the follow-up
  test fix at **10,921 nodes / 28,624 edges**.

Browser screenshots were captured and visually inspected:

- `.tmp/issue-336-evidence/01-composite-session-action.png` (79,210 bytes)
- `.tmp/issue-336-evidence/02-zero-session-worktree.png` (78,347 bytes)
- `.tmp/issue-336-evidence/03-explicit-worktree-task-action.png` (89,536 bytes)

## Runtime-specific review

The requested `$code-review` skill was loaded exactly from
`/home/work/.agents/skills/code-review/SKILL.md`. Fixed point `b656df9` resolved to
`b656df9158ba2b48bd8d3f1208feb2cf1f690832`; the reviewed command was
`git diff b656df9...HEAD`. For the required follow-up review, the commit list was:

- `231447c test(archive): await session mutation before restore (#336)`
- `b064517 docs: add issue 336 agent report`
- `efcb0d5 fix(project-view): separate session and task archive (#336)`

The skill's read-only Standards and Spec reviewers ran in parallel as
`/root/review_standards_336` and `/root/review_spec_336`, using `AGENTS.md`, `CONTRIBUTING.md`, the
skill's full smell baseline, issue #336, and the agreed issue #328 context.

### Standards

No actionable findings. The reviewer found the diff focused, consistent with existing store and
browser-test patterns, and correctly verified through the isolated `server.ts` browser flow. It
found no hard documented-standard violation. A possible small `Middle Man` judgement call was
explicitly not elevated because the shared helper centralizes canonical Session identity and the
requested finding filter excludes standalone style preferences.

### Spec

No acceptance-criteria findings and no acceptance-relevant scope creep. The reviewer confirmed the
Session/Worktree archive separation, zero-Session Worktree preservation, retained-surface retirement
or read-locking, explicit Task archive semantics, and existing restore/mutation density flow.

Review summary: **Standards 0 actionable findings (no worst issue); Spec 0 findings (no worst
issue).** The earlier pre-follow-up review's task-owned header-unarchive finding remains resolved by
exposing only the required archive action there.

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
E2E synchronization follow-up commit: `231447cba09d6193b1350835eab2037fb07b0095`.
This report is committed separately as the durable handoff; no push or GitHub mutation was made.

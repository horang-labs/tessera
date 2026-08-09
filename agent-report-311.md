# Agent report — GitHub issue 311

## Outcome

Git delivery state now belongs to a canonical worktree owner keyed by the Git-reported `repoRoot`, rather than to a mounted `useGitPanelController`. The owner keeps the Worktree Git Draft (message plus exclusion-based Commit Selection), pending verb, and retained action failure coherent across panel remounts and sessions. Sessions opened in different directories inside the same checkout resolve to the same owner; different repositories remain isolated.

Every existing Git snapshot entry point still calls `applyGitPanelData`. That one boundary now reconciles exclusions with the current changed paths and clears message/exclusions when the worktree becomes clean, so poll, focus refresh, and WebSocket broadcast all have the same external-change behavior. Action routes, polling cadence, confirmation state, generation requests, notifications, and remote-action execution were not replaced.

The unknown-state panel already allowed message input before its first Git snapshot. A provisional session key therefore holds only that early input and migrates its message into the canonical owner once Git returns `repoRoot`. Existing canonical exclusions, pending state, and retained failure win during that migration.

## `/implement` and `/tdd`

The provider's `$implement` skill was invoked from `/home/work/.agents/skills/implement/SKILL.md` with issue 311 and ADR 0001 as the supplied ticket/spec. It required TDD where possible, regular targeted checks, `$code-review`, and a commit on the current branch. The ticket's explicit instruction not to run the full suite in a child worktree overrode the skill's generic full-suite step.

The pre-agreed `/tdd` seam was the user-visible full Git panel, not the private Zustand representation. `tests/git-worktree-delivery-state.e2e.mjs` drives real Git repositories, a real isolated development server, and Chromium. Its first post-install RED was panel close/reopen: the message was `""` instead of `"shared draft"`. Vertical slices then covered:

- close/reopen retention of message and an excluded file;
- two sessions whose work directories are the checkout root and a nested directory sharing one canonical draft;
- a different repository remaining isolated;
- one delayed action locking same-worktree panels but not the other worktree;
- failure retention across remount/session changes and failure isolation;
- external clean-to-dirty transitions clearing stale draft state and selecting the newly changed path;
- a deliberately delayed first snapshot merging provisional message input without erasing canonical exclusion or pending state (the race found by review).

The final E2E file is 187 lines.

## Verification

Exact commands and measured results:

- `env | rg -i 'tessera|electron|__CFBundleIdentifier' || true` — confirmed inherited Tessera session variables before starting a server. `tests/helpers/dev-server.mjs` removed host runtime variables and used a throwaway `TESSERA_DATA_DIR`.
- `npm install` — installed 1,042 packages. npm reported 46 audit findings (2 low, 13 moderate, 28 high, 3 critical); dependency remediation was outside this ticket.
- `node tests/git-worktree-delivery-state.e2e.mjs` — RED after dependency installation at the first close/reopen assertion: actual `""`, expected `"shared draft"`.
- `node tests/git-worktree-delivery-state.e2e.mjs` — final GREEN with `{"sharedDraft":true,"isolatedPending":true,"cleanReset":true}`. The delayed-snapshot migration assertions also passed.
- `npx tsx --test tests/git-panel-poll-refresh.test.ts tests/git-action-failure-report.test.ts tests/git-action-session-refresh.test.ts tests/git-primary-action.test.ts tests/git-action-menu.test.ts` — 86 tests passed, 0 failed, 5.63 s on the final pre-review run; the same 86 passed again after review fixes.
- `npx tsx --test tests/git-commit-message.test.ts tests/git-default-branch-confirmation.test.ts tests/git-actions.test.ts tests/git-push-action.test.ts tests/git-pull-action.test.ts tests/git-create-pr-action.test.ts tests/git-abort-action.test.ts` — 59 tests passed, 0 failed, 3.57 s.
- `npx tsc --noEmit` — exit 0, no diagnostics (2.85 s on the final run).
- `npm run lint` — exit 0 (28.66 s), 0 errors and 3 pre-existing warnings in `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`; none are in this diff.
- `graphify update .` — exit 0; rebuilt 9,934 nodes, 26,439 edges, and 381 communities. It noted that community labels can be refreshed separately.
- `git diff --check b83c679...HEAD` — exit 0.

The behavioral screenshot is `/home/work/tmp/tessera-ticket-311/shared-failure.png` (Windows/WSL path: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-311\shared-failure.png`). It shows the shared message, retained failed-commit banner, and one excluded of two changed files in the full desktop Git panel.

## `$code-review`

The skill at `/home/work/.agents/skills/code-review/SKILL.md` was invoked exactly against fixed point `b83c679c542e8679ccc8a5fc4304ac296ffb91f5` with:

- diff: `git diff b83c679...HEAD`;
- review-time commit list: `daf2006 feat(git): scope delivery drafts by worktree`;
- standards sources: `AGENTS.md`, `CONTRIBUTING.md`, and the skill's full Fowler smell baseline;
- spec sources: GitHub issue 311 and `docs/adr/0001-key-git-delivery-drafts-by-worktree.md`.

Two explicitly authorized review-only agents ran in parallel.

### Standards

No hard documented-standard violations were found. One judgement-call Middle Man finding identified the local `markPending` callback as a pure delegate to `markWorktreePending`. The wrapper was removed.

### Spec

One high-severity acceptance gap was found: adopting a provisional delivery entry wholesale could erase an existing canonical owner's exclusions, pending verb, and retained failure. The migration now overlays only the provisional message onto canonical state, and the delayed-first-snapshot E2E covers this path.

Review summary: Standards 1 judgement-call finding (worst: minor Middle Man), Spec 1 finding (worst: high-severity canonical migration state loss); both were applied.

## Commits

- `daf200667fb59b0b49583ef4c5a5bd4fb82536c99` — initial worktree-scoped owner and user-visible E2E.
- `e56352a43de683445168788bbbed014e75a0e1f6` — review fix preserving canonical state during provisional migration; final implementation commit.

No push or pull request was created.

## Not verified

- The full repository test suite was not run, per the ticket's orchestration rule. Targeted coverage totals 145 passing tests plus the standalone browser E2E.
- An isolated Windows Electron package was not run because this change is renderer-local state ownership and does not cross a process, OS, filesystem, or network boundary. The required browser topology was exercised with an isolated server and real filesystem Git repositories.
- Real remote GitHub operations were not performed. Existing commit-generation, confirmation, commit, push, pull, create-PR, and abort tests passed with their established isolated fixtures.

## Deliberately left out

- The parent issue's future desktop header, compact composer, and phone surfaces.
- Server-side or disk persistence of drafts, staging/index modes, snapshot-selection modes, and conflict dialogs.
- Changes to polling cadence, broadcast fan-out, Git action routes, confirmation UX, action ordering, remote configuration, or failure wording.
- Dependency/audit upgrades and the three unrelated lint warnings.

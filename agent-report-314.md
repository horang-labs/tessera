# Agent report — issue 314

## What changed and why

- Promoted unfinished merge, rebase, and cherry-pick states to an enabled desktop
  `Resolve conflicts` primary action. The action is navigation only: it opens the full Git
  panel and focuses Conflict Recovery without dispatching a Git mutation.
- Added a focused recovery surface that names the live operation and lists only status
  entries still classified as conflicted. Selecting a path reuses the existing workspace
  diff flow and does not modify the file.
- Reused the predecessor ticket's conflict-specific disabled reasons, matching abort menu
  action, live-operation revalidation, durable failure report, refresh, and next-action
  derivation. Ordinary commit, pull, and compound commit actions stay visibly disabled.
- Preserved `changedFilesTruncated` in the recovery model after review. A truncated list now
  shows a `+` count and an explicit incomplete-list warning, and cannot falsely claim that no
  unresolved paths remain.
- Added English, Korean, Japanese, and Chinese recovery copy plus state/navigation tests and
  a 185-line real-Git E2E covering the critical path, a reachable desktop non-regression,
  and failed-abort retry.

## Implementation and TDD

The provider implementation skill was invoked as `$implement`, with GitHub issue 314 as the
ticket and `docs/adr/0001-key-git-delivery-drafts-by-worktree.md` as the agreed design input.
The implementation skill delegated these pre-agreed seams through `/tdd`:

1. public Primary Git Action and conflict-recovery state derivation;
2. full-panel navigation, focus request, and unresolved-path presentation;
3. actual merge/rebase/cherry-pick abort, durable failure/retry, refresh, and stale-request
   rejection.

The initial red command was:

`npx tsx --test tests/git-primary-action.test.ts tests/git-desktop-commit-control.test.tsx tests/git-conflict-recovery.test.ts`

It failed because conflict still derived a disabled `commit` action and the recovery model
and navigation store action did not exist. After `$code-review`, a second red test proved
that the truncated-payload flag was lost (`undefined` instead of the expected boolean) before
the review fix was implemented.

## Verification

- `npm ci` — exit 0; installed 1,042 packages. The existing audit findings were recorded but
  no unrelated dependency or audit fix was applied.
- `npx tsx --test tests/git-conflict-recovery.test.ts tests/git-primary-action.test.ts tests/git-action-menu.test.ts tests/git-abort-action.test.ts tests/git-conflict-detection.test.ts tests/git-action-report.test.ts tests/git-action-session-refresh.test.ts tests/git-panel-poll-refresh.test.ts tests/git-desktop-commit-control.test.tsx`
  — final exit 0 in 8.38 s; 118 passed, 0 failed. This includes real merge, rebase, and
  cherry-pick aborts plus stale no-operation rejection.
- `node tests/git-conflict-recovery.e2e.mjs` — final exit 0 in 33.86 s. A real content conflict
  and modify/delete conflict displaced the desktop Commit control; Resolve conflicts focused
  the recovery surface; only two unresolved paths were shown; an ordinary dirty path stayed
  out; opening Diff left file contents unchanged; Commit, Commit & Push, and Pull were
  disabled; only Abort merge was offered; an `index.lock` made abort fail durably; the same
  action retried successfully after removing the lock; the remaining dirty file restored
  Commit; and a stale abort returned HTTP 409 `no_conflict_in_progress`.
- `npx tsc --noEmit` — final exit 0 in 3.58 s.
- `npm run lint` — final exit 0 in 35.00 s; 0 errors and the same 3 pre-existing warnings in
  `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`.
- `git diff --check` and `git diff --cached --check` — exit 0 with no output.
- `graphify update .` — final exit 0 in 21.48 s; rebuilt 9,989 nodes, 26,560 edges, and 377
  communities. The graph remains ignored and was not committed.
- Screenshot: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-314\conflict-recovery.png`, SHA-256
  `07ce84fb933f77676fa787644a0778512162693eeff4ade3256bbee3dd3883bf`.

### Packaged Windows Electron topology

The repository's `tessera-electron-dev` skill was used because the installed topology is a
packaged Windows Tessera server opening CLI-owned Git paths through WSL. There was no
`TESSERA_DEV_PORT` override.

1. `bash "$PWD/.codex/skills/tessera-electron-dev/scripts/build_and_launch.sh" --repo "$PWD" --count 1 --session-id codex-0809-t314 --seed-data-dir /home/work/.tessera`
   exited 0. The production build completed, prepared 7,989 runtime files (171 MB), built the
   portable app, and launched isolated PID 36000 with CDP port 9337, server port 32124, and
   data root `C:\Users\work\AppData\Local\TesseraTestInstances\codex-0809-t314\data`.
2. The portable artifact was
   `C:\Users\work\Downloads\Tessera-0.2.3-hotfix.1-feature-0809-t314-electron-dev-20260809-204722.exe`
   (SHA-256 `8054347dc8a974162631f3bb7d8f7fe09787b59fd5145344f1c93624b12ef898`);
   the launched unpacked executable SHA-256 was
   `fc4d91b378fc78ad58b436bbcf784c14b8e50bff6f28af62cbdb5410ca7d329a`.
3. Windows Node connected to the actual Electron renderer over CDP while the packaged
   Windows server called Git in WSL. The same real repository assertions above passed and
   produced the retained screenshot. One initial WSL Git read hit the product's existing
   10-second timeout; a direct authenticated Windows-side endpoint probe then returned the
   full merge-conflict payload in 126 ms. The bounded verification retried one renderer load
   and completed successfully; no product behavior was changed for this transient.
4. `stop-electron-test-session.ps1 -SessionId codex-0809-t314 -RemoveData` exited 0, stopped
   only PID 36000, and removed the isolated data and manifest. Ports 32124 and 9337 closed;
   the user's installed app remained on PID 33516/port 32123. Source DB SHA-256 values stayed
   `e3271c7d…c380` (`tessera-dev.db`) and `8095eae0…54c` (`tessera.db`). Generated Downloads
   copies were deleted; WSL build outputs and temporary fixtures were moved to trash.

## Runtime review

The `$code-review` skill was invoked exactly at fixed point
`feature/0809-t312` (`ba07730a6c6b99e0ceb5eb9f8a4fcffb7eb5ccf1`) with its two explicitly
authorized parallel review agents and `git diff feature/0809-t312...HEAD`:

- Standards found no hard documented-standard violation and no acceptance-risking baseline
  smell after inspecting `AGENTS.md`, `CONTRIBUTING.md`, `README.md`, `package.json`, and the
  referenced runtime testing notes.
- Spec found one P2 acceptance gap: the recovery model discarded a truncated status marker,
  so a >1,000-entry payload could undercount unresolved paths or falsely say none remained.
  Commit `8664b16` preserves the marker, renders an incomplete-list warning and `+` count,
  suppresses the false empty-state claim, and adds the empty-but-truncated unit case. The Spec
  reviewer rechecked updated `HEAD` and marked the finding resolved. It found no scope creep.

Final review summary: Standards 0 findings; Spec 1 finding, resolved (worst: truncated
unresolved-path presentation, P2).

## Commits

- `f1e9957184ce24b11ccafb021523b72497c8a319` — `feat(git): add conflict recovery workflow`
- `8664b16900859e9a9129ed1c21ffeab2cdffb8c7` — `fix(git): warn when conflict paths are truncated`

## Not verified or deliberately left out

- Nothing in the normal-size acceptance path remains unverified. The >1,000-status-entry
  warning is covered by state derivation, rendering logic, translations, typecheck, and lint,
  but a repository containing more than 1,000 real conflict entries was not created for a
  visual browser run.
- The full repository test suite was deliberately not run under the ticket's child-worktree
  verification rule.
- Conflict resolution itself remains manual in the existing diff/editor or terminal. Resolve
  conflicts does not edit, stage, commit, continue, or automatically abort anything.
- The transient initial packaged WSL Git timeout was characterized but deliberately left out
  of scope because issue 314 does not ask to change cross-process startup timing.
- No dependency audit fix, push, or pull request was performed.

# Agent report — issue 312

## What changed and why

- Added a desktop split commit control immediately before the Git panel toggle. Its stat
  reports the whole worktree while the compact composer selection remains independent.
- Added a compact commit composer that reuses the worktree-keyed Git controller state, so
  its draft, exclusions, generation result, commit result, and refresh behavior hand off to
  the full Git panel without copying state.
- Reused the existing Git action menu, primary-action model, anchored-overlay geometry, and
  escape-close hook. The stat is hidden before the Commit label at medium widths, while the
  Git toggle remains reachable.
- Added localized accessible names and non-color diff-stat text, plus component and real-Git
  browser coverage for the acceptance criteria.

## Implementation and TDD

The provider implementation skill was invoked as `$implement`, with GitHub issue 312 as the
ticket and `docs/adr/0001-key-git-delivery-drafts-by-worktree.md` as the agreed design input.
The `/tdd` workflow was used for these seams:

1. compact/full-panel worktree-keyed draft and exclusion handoff;
2. the actual selected-file commit request and post-commit refresh/clear behavior.

The initial red checks failed because `git-desktop-commit-control` did not exist and the
browser could not find `desktop-commit-control`. The resulting implementation is covered by
`tests/git-desktop-commit-control.test.tsx` and the 174-line
`tests/git-desktop-commit-control.e2e.mjs`.

## Verification

- `npx tsx --test tests/git-desktop-commit-control.test.tsx` — exit 0 in 0.88 s;
  2 passed, 0 failed.
- `node tests/git-desktop-commit-control.e2e.mjs` — exit 0 in 35.46 s. The real Git
  commit contained only `b.txt`; `a.txt` remained dirty and became selected after refresh;
  compact/full draft state flowed both ways across two sessions for the same worktree; and
  the 900 px case hid the stat while retaining Commit and the Git toggle.
- `npx tsx --test tests/git-panel-poll-refresh.test.ts tests/git-action-failure-report.test.ts tests/git-action-session-refresh.test.ts tests/git-primary-action.test.ts tests/git-action-menu.test.ts tests/git-commit-message.test.ts tests/git-actions.test.ts`
  — exit 0 in 9.42 s; 105 passed, 0 failed.
- `npx tsc --noEmit` — exit 0 in 21.21 s.
- `npm run lint` — exit 0 in 38.14 s; 0 errors and 3 pre-existing warnings in
  `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`.
- `git diff --check 6ff19c22d1fa8287e4aa260cf62c178af207ae2f` — exit 0 with no output.
- `graphify update .` — exit 0; rebuilt 9,974 nodes, 26,521 edges, and 374 communities.
- Web E2E screenshot: `/home/work/tmp/tessera-ticket-312/compact-composer.png`.

### Packaged Windows Electron topology

The repository's `tessera-electron-dev` workflow was used because the installed topology is
a Windows packaged server opening CLI-owned paths through WSL. There was no
`TESSERA_DEV_PORT` override.

1. `bash "$PWD/.codex/skills/tessera-electron-dev/scripts/build_and_launch.sh" --repo "$PWD" --count 1 --session-id codex-0809-t312 --seed-data-dir /home/work/.tessera`
   completed the production Next build and TypeScript pass, then Wine `rcedit` was externally
   killed. No instance was launched. Re-running only
   `npx electron-builder --win portable --x64 --publish never` exited 0, after which the same
   skill launcher was invoked with its `--artifact` and `--app-dir` options.
2. The isolated instance became ready at CDP `127.0.0.1:9337` and packaged server port
   `32124`, using PID 27960 and data root
   `C:\Users\work\AppData\Local\TesseraTestInstances\codex-0809-t312\data`. The portable
   artifact SHA-256 was `51b76642da6ce42e154c89915f760d8b7a1b4efca25e742d2e4b6a3851fb2894`;
   the launched unpacked executable SHA-256 was
   `d7c6851e789fbf7b6300200a942f9a972f139f5440d89ce4b8ce5ad5b8b7d04e`.
3. Windows Node connected to the actual Electron renderer through CDP. The control's right
   edge and Git toggle's left edge were both exactly `x=1208`; the visible whole-tree text was
   `+73 −0`; accessible labels named the worktree and counts; the composer opened; opening
   the action menu closed it and exposed the menu; and the stat opened the full panel's
   Changed files section. Screenshot:
   `/home/work/tmp/tessera-ticket-312/electron-compact-composer.png`.
4. `scripts/stop-electron-test-session.ps1 -SessionId codex-0809-t312 -RemoveData` stopped
   only PID 27960 and removed its manifest/copied DB/profile. Ports 32124 and 9337 closed.
   The installed app PIDs 16412, 33516, and 44248 remained alive on port 32123, and source
   DB hashes remained `e3271c7d…c380` (`tessera-dev.db`) and `8095eae0…54c` (`tessera.db`).
   The generated Windows Downloads copies were removed; WSL build outputs were moved to
   trash.

No full test suite was run, per the ticket's child-worktree verification rule.

## Runtime review

The `$code-review` skill was invoked at fixed point
`6ff19c22d1fa8287e4aa260cf62c178af207ae2f` with its two authorized parallel review agents:

- Standards found duplicated escape handling and anchored-overlay positioning. Both were
  replaced with the repository's `useCloseOnEscape`, `ANCHORED_VIEWPORT_MARGIN`, and
  `resolveAnchoredAlignedLeft` utilities.
- Spec found that the menu could render beneath the open composer and that canonical
  same-worktree sharing was not directly exercised. Opening the menu now closes the composer,
  and the E2E test now proves two sessions for one canonical worktree share draft/exclusions.

All acceptance-criteria and hard standards findings were applied. No scope-creep finding was
reported.

## Commits

- `8075f33ed39884a434fcc87c78193286e6bd6e2b` — `feat(git): add desktop commit delivery control`
- `11f8bf2f628201ba85216c29dedc3a23eba3e4d5` — `fix(git): keep desktop delivery overlays reachable`

## Not verified or deliberately left out

- Nothing in the acceptance criteria remains unverified. The full repository test suite was
  deliberately not run under the ticket's orchestration rule.
- Mobile received no compact header control; the existing Git panel remains the mobile path,
  as required by the desktop-only ticket.
- Generate and commit remain explicit user actions; no automatic generation or commit was
  added.
- No push or pull request was performed.

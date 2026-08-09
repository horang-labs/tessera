# Agent report — GitHub issue 313

## Outcome

Implemented the complete desktop Primary Git Action ladder on top of ticket 312. The shared header control now derives one safe next step from the current worktree snapshot: Loading, Commit, Pull, Publish, Push, Create PR, View PR, blocked, or Up to date. Counts are shown for Commit/Pull/Push where known.

The companion menu now keeps the agreed stable order:

1. Commit
2. Commit & Push
3. Push/Publish
4. Pull
5. Create/View PR
6. Open Source Control

Unavailable entries remain visible with prerequisite reasons. The implementation removed last-used action promotion, preserves default-branch confirmation, reports the actual pending verb, and renders durable shared-worktree failures beside the header action as well as in the full Git panel. A successful Commit is retained when the Push half of Commit & Push fails, and the refreshed primary action becomes Push.

Review follow-up made comparison failures fail closed: a tracking branch with unknown ahead/behind counts holds a disabled Loading rung, diverged Push requires Pull first, and Create PR requires Pull/Push before it can be enabled. The full Git panel retains its commit draft form while that loading snapshot resolves, preserving the ADR's canonical-worktree draft ownership.

## Provider skill and TDD

The user invoked the provider's `$implement` skill directly. I read `/home/work/.agents/skills/implement/SKILL.md` and followed its implementation loop. The skill routed these seams through `/tdd` (`/home/work/.agents/skills/tdd/SKILL.md`):

- pure `GitStateSnapshot -> GitPrimaryAction` ladder derivation;
- pure `GitStateSnapshot -> fixed Git menu` derivation and prerequisite reasons;
- shared canonical-worktree owner integration across header/full-panel surfaces and multiple sessions.

Representative RED/GREEN evidence:

- Added Push count, View PR, Up to date, Loading, fixed-menu, pending-Publish, and missing-remote/detached cases one slice at a time; each new assertion failed before its implementation and passed afterward.
- Review regression command `npx tsx --test tests/git-primary-action.test.ts tests/git-action-menu.test.ts` first produced 53 pass / 2 fail: diverged menu Push was enabled and an uncounted branch produced Push instead of disabled Loading. After the fix it produced 55 pass / 0 fail.
- The new browser integration test exercises `Commit -> Pull -> Push -> Create PR`, fixed menu order, configured `pull.rebase=true`, Commit & Push partial failure, durable failure detail, clean retry, and shared-owner refresh through two sessions.

## Verification

No full suite was run, per the ticket/orchestrator instruction.

### Targeted code and integration checks

- `npx tsx --test tests/git-primary-action.test.ts tests/git-action-menu.test.ts tests/git-default-branch-confirmation.test.ts tests/git-panel-poll-refresh.test.ts tests/git-action-session-refresh.test.ts tests/git-action-failure-report.test.ts tests/git-action-report.test.ts tests/git-actions.test.ts tests/git-push-action.test.ts tests/git-pull-action.test.ts tests/git-create-pr-action.test.ts tests/git-desktop-commit-control.test.tsx`
  - 155 tests, 155 pass, 0 fail; `real 8.17s`.
- `npx tsx tests/git-desktop-action-ladder.e2e.mjs`
  - pass; `real 60.76s`; 160 lines (under the 200-line limit).
  - measured result: `ladder=[commit,pull,push,create_pr]`, `partialFailure=true`, `sharedOwner=true`.
  - screenshot: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-313\partial-push-failure.png`.
- `npx tsx tests/git-desktop-commit-control.e2e.mjs`
  - pass; `real 29.67s`; committed only `b.txt`, preserved the 900px desktop layout.
  - screenshot: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-312\compact-composer.png`.
- `npx tsx tests/git-worktree-delivery-state.e2e.mjs`
  - final pass; `real 81.00s`; `sharedDraft=true`, `isolatedPending=true`, `cleanReset=true`.
  - The first two attempts timed out at the pre-identity draft input (`real 76.30s` and `79.85s`), exposing the new Loading rung hiding the full-panel draft form. After preserving that form, a third run reached the failure assertion and correctly found two banners (new header plus existing panel); the test was scoped to both surfaces. The final run passed.
- `npx tsc --noEmit`
  - pass; final `real 6.01s`.
- `npm run lint`
  - exit 0; `real 38.39s`; 0 errors and 3 pre-existing warnings in `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`.
- `git diff --check`
  - pass.
- `graphify update .`
  - pass; final `real 24.51s`; 9,984 nodes, 26,541 edges, 405 communities. The generated graph artifacts remain ignored.

`npm install` was required because this worktree initially had no `node_modules`; it installed 1,042 packages. The audit summary reported 46 existing findings (2 low, 13 moderate, 28 high, 3 critical); no dependency upgrade or audit fix was attempted because it is outside issue 313.

### Packaged Windows Electron + WSL CLI topology

I read `.claude/notes/dev-server.md`, `.claude/notes/cross-boundary-testing.md`, `.claude/notes/electron-isolated-test.md`, and the repository `tessera-electron-dev` skill before running the packaged test.

Command:

```text
bash "$PWD/.codex/skills/tessera-electron-dev/scripts/build_and_launch.sh" --repo "$PWD" --count 1 --session-id codex-0809-t313 --seed-data-dir /home/work/.tessera
```

Measured evidence:

- production Next build compiled in 69s; its TypeScript phase completed in 10.2s;
- portable artifact SHA-256: `b45ec86d8b910e5b64074f303b880760c957a84eb70c4be08ba5e77d830b35ee`;
- launched isolated Electron PID 46996 with owner token `8760ea6c068443f3a025f943a6008edc`;
- actual packaged server URL `http://localhost:32124/`, CDP `http://127.0.0.1:9337`, renderer page `http://localhost:32124/chat`, title `Tessera`;
- Windows Node/CDP observed primary `Push (3)` and the exact six menu slots above;
- screenshot: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-313\electron-fixed-menu.png`;
- stopped only session `codex-0809-t313` through `scripts/stop-electron-test-session.ps1`; it reported only PID 46996 stopped.

The user's installed Tessera remained PID 44248 on port 32123. Source DB SHA-256 values were unchanged before/after: `tessera-dev.db` = `e3271c7dc7a9ef4babfc82be8bb84e2c50ae0828f59509097c1e360fbea9c380`, `tessera.db` = `8095eae016a1675fc896f2d95477865f6d7c00b8dff6221f1302847bad58a54c`.

## `$code-review` invocation and findings

Invoked `/home/work/.agents/skills/code-review/SKILL.md` exactly against fixed point `feature/0809-t312` (`ba07730a6c6b99e0ceb5eb9f8a4fcffb7eb5ccf1`) using `git diff feature/0809-t312...HEAD` and `git log feature/0809-t312..HEAD --oneline`. The skill's Standards and Spec agents ran in parallel, review-only, with no edits or nested agents.

### Standards

- Hard documented violations: 0.
- One non-eligible judgement-call smell, Repeated Switches, was noted in the controller's two action dispatch paths. It is neither a documented hard violation nor an acceptance gap, so it was deliberately not refactored.

### Spec

Three acceptance gaps were reported and all were applied:

1. Diverged menu Push and unsynced Create PR could bypass ladder prerequisites. Added disabled Pull-first/Push-first reasons.
2. Null comparison counts could expose speculative enabled Push/Pull. They now fail closed as state unknown.
3. Shared-owner integration coverage was partial. The new ladder E2E now uses two sessions on one canonical worktree and verifies cross-session Pull, Push, partial failure, and Create PR refreshes; the existing worktree-owner E2E was also run and updated for the header failure surface.

Summary: Standards 0 eligible findings; Spec 3 findings, all resolved. The worst Standards observation was non-actionable repeated dispatch branching; the worst Spec issue was speculative remote actions on unknown/diverged state.

## What could not be verified

- No live GitHub repository was mutated, so enabled Create PR and View PR were not clicked against a real external PR. Their pure matrix/action tests passed; the local bare-remote E2E correctly reached disabled Create PR for a non-GitHub remote.
- The isolated Electron package contained the initial implementation state used for `$code-review`. The review-only fail-closed comparison changes and loading-form preservation were verified afterward with the targeted browser E2Es, TypeScript, and lint, but the several-minute Windows package build was not repeated. The Windows server + WSL CLI action/menu wiring those fixes reuse was exercised in the isolated package.
- The portable Windows executable was unsigned because no signing identity was configured; packaging and execution still succeeded.
- The orchestrator-owned full suite and integrated-wave checks were intentionally not run here.

## Deliberately left out

- Phone-specific Git delivery and conflict-recovery workflows assigned to later tickets were not implemented.
- No broad dispatcher refactor was made for the review's non-hard Repeated Switches observation.
- No dependency upgrades, audit fixes, unrelated lint-warning fixes, push, or pull request were performed.
- No commits predating this session/fixed point were graded or rewritten.

## Commits

- `f66abde59b3e29a49a533c686674716d7371e9a2` — `feat(git): add desktop delivery action ladder`
- `2a743dc396d3febad1619dd7b0b9df35d9242464` — `fix(git): close speculative delivery actions`

This report is committed separately after its contents are finalized; the final branch HEAD is reported to the orchestrator/user after that commit.

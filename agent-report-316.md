# Issue 316 implementation report

## Issue summary and outcome

Implemented the complete Git delivery experience for Tessera's existing phone UI. The phone header keeps exactly `[Sidebar] [Current tab] [New tab] [Git]`; the Git control remains a stable branch icon with a changed-file badge capped at `99+` and a separate pending spinner. Opening it always selects the Git tab, including after Files, Scripts, or Context was previously persisted.

The full-screen Git panel opens dirty worktrees with the shared Commit Composer expanded and without autofocus. The composer or current Primary Git Action remains fixed directly under the panel tabs while summary, changed files, failures, conflict recovery, commits, and the rest of the Git content share the scroll region. Whole-worktree diff totals remain separate from the selected-file count and selected diff totals.

Git action menus and default-branch confirmation now use one safe-area-aware phone bottom-sheet shell. Rows and confirmation controls meet the 44px touch target, disabled menu actions keep their visible reasons, and a shared history stack makes browser/Android Back and Escape dismiss the topmost sheet before the full-screen panel. The phone header, full panel, and desktop control continue to consume the same canonical worktree-scoped controller and draft/pending/failure state required by ADR 0001.

## Implementation details

- `src/components/tab/tab-bar.tsx` adds the stable phone Git control, truthful count/pending treatments, localized accessibility copy, and `openTab('git')` entry behavior.
- `src/components/git/git-panel.tsx` and `git-panel-sections.tsx` place the phone action area below the tabs and move the remaining Git sections into one scroll region without changing desktop layout.
- `src/components/ui/phone-bottom-sheet.tsx` owns the shared portal, backdrop, safe-area sizing, rounded shell, and drag handle.
- `src/components/git/git-action-menu.tsx` uses that sheet on phone, preserves the desktop anchored menu, and shares one action-item derivation between both surfaces.
- `src/components/git/git-default-branch-confirm-dialog.tsx` keeps the desktop dialog and renders the same confirmation as a touch-sized phone sheet.
- `src/hooks/use-phone-overlay-navigation.ts` gives each phone overlay one same-URL history entry and coordinates explicit dismissal, Back, Escape, Strict Mode cleanup, and follow-up actions.
- `tests/git-phone-delivery.e2e.mjs` drives the visible 360x776 phone journey and desktop non-regression; `tests/helpers/git-phone-delivery.mjs` owns only reusable fixture, route, geometry, screenshot, and held-request mechanics.

## Test-driven development record

The public seams were the four-control phone header, full-screen Git panel, worktree-owned delivery state, bottom sheets, and browser-visible Back/Escape behavior.

Red-to-green slices:

1. The interrupted E2E initially timed out waiting for `git-panel`: React Strict Mode cleanup navigated the newly pushed overlay history entry backward. Cleanup now removes its marker with `replaceState`; the test advanced through header, composer, totals, scrolling, and action-sheet checks.
2. The next red timed out waiting for `git-default-branch-confirm-sheet`. The phone confirmation sheet and shared overlay stack made safe-area, touch-target, role/name, Escape, and Back assertions green.
3. Review added a persisted-tab regression: select Files, close, and reopen from the phone Git icon. It failed waiting for the commit message because generic `toggle` restored Files. The entry now calls `openTab('git')`, and the regression is green.

The action test also exposed that a held Push on `main` must accept the existing default-branch confirmation first; the scenario was corrected without weakening that safety boundary.

## Exact verification

- `node tests/git-phone-delivery.e2e.mjs`
  - Passed with `{"artifactDir":"/home/work/tmp/tessera-ticket-316","changedFiles":101}`.
  - Covered exactly four 44px header controls, `99+`, stable icon and pending progress, dirty composer/no autofocus, persisted non-Git-tab reopening, distinct totals, fixed action while files scroll, both safe-area sheets, disabled reasons, accessible names, two-level Escape and Back, Commit-to-Push rederivation in place, pending state after panel close, and desktop menu non-regression.
- `test "$(wc -l < tests/git-phone-delivery.e2e.mjs)" -le 190 && wc -l tests/git-phone-delivery.e2e.mjs tests/helpers/git-phone-delivery.mjs`
  - Passed: the E2E is 160 lines and its assertion-free support module is 138 lines.
- `npx tsx --test tests/git-default-branch-confirmation.test.ts tests/git-desktop-commit-control.test.tsx tests/git-primary-action.test.ts tests/git-action-menu.test.ts tests/git-conflict-recovery.test.ts tests/git-conflict-handoff.test.ts`
  - 77 passed, 0 failed, 0 skipped.
- `node tests/git-worktree-delivery-state.e2e.mjs`
  - Passed with `sharedDraft=true`, `isolatedPending=true`, and `cleanReset=true`.
- `npx tsc --noEmit && npx eslint src/components/ui/phone-bottom-sheet.tsx src/components/git/git-action-menu.tsx src/components/git/git-default-branch-confirm-dialog.tsx src/components/git/git-panel-sections.tsx src/components/git/git-panel.tsx src/components/tab/tab-bar.tsx src/hooks/use-phone-overlay-navigation.ts tests/git-phone-delivery.e2e.mjs`
  - Passed with no TypeScript or lint findings.
- `git diff --check`
  - Passed with no whitespace errors.
- `graphify update .`
  - Passed; rebuilt 9,917 nodes, 26,545 edges, and 387 communities. Ignored graph outputs were not committed.

Screenshots (WSL paths for user handoff):

- `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-316\phone-fixed-composer.png` — SHA-256 `b4038aa80374f7bfcbc7aee1ef7502ab69ad3a006eb0f4271302a855eeb64e25`
- `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-316\phone-action-sheet.png` — SHA-256 `efdd2bedbfee9a288e01744d402f4dfe0478d84d5bdb034ab5ba023e2ec0f7dc`
- `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-316\phone-default-confirmation.png` — SHA-256 `e657a48a312acaf98eccb52deac9948eec5896da5d56ca9bf06cb522defb7234`
- `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-316\phone-pending-badge.png` — SHA-256 `adac4569eef6d968604f72bbac8dc782536d32a3e0e20bb3242df8a312fcac22`

No full repository suite was run, per the issue instruction. No isolated Windows Electron build was needed: this change is renderer-only and introduces no Windows-server, CLI, filesystem, process, or network-boundary behavior. The isolated WSL development server plus Chromium test exercises the relevant topology with a real Git repository and remote.

## Two-axis code review

Fixed point: `1de912a697e6565046db36ef001529dc670bb933` (the integrated #311-#315 HEAD before issue 316).

### Standards

Initial review found no documented-standard violations and two judgement-call Duplicated Code smells:

1. Phone and desktop action menus repeated `actions.map(...)` and commit-draft blocking logic. Resolved with `GitActionMenuItems`.
2. The action menu and default-branch confirmation repeated portal/backdrop/safe-area sheet markup. Resolved with `PhoneBottomSheet`.

Final Standards recheck: no hard violations and no judgement-call smells.

### Spec

Initial review found one P1 gap and no scope creep: the persisted `panelTab` allowed the phone Git icon to reopen Files/Scripts/Context, violating “A dirty full-screen Git panel opens with the Commit Composer expanded.” Resolved by opening the Git tab explicitly and adding the persisted-tab E2E slice described above.

Final Spec recheck: no findings and no scope creep.

Initial summary: Standards 2 judgement-call findings (worst: duplicated sheet behavior); Spec 1 finding (worst: dirty phone entry could omit the composer). Final summary: Standards 0 findings; Spec 0 findings.

The root orchestrator then caught the wave's E2E-size rule: the original file was 231 lines. Reusable mechanics were extracted without moving any of its 18 pass/fail assertions or changing the interaction sequence. A final two-axis recheck confirmed the 160-line E2E and 138-line assertion-free helper preserve all coverage, with Standards 0 findings and Spec 0 findings.

## Commits and final implementation SHA

- `5d5ffa2acee5f5110ec793d06833e6ed14837ad2` — `feat(git): complete phone delivery UI`
- `2250e0e84dc4f8a851d89b5cf081f9970b2676a5` — `fix(git): reopen phone delivery on Git`
- `46dc07c104ac43b9ea52a9057e21e0771e6f7807` — `test(git): keep phone delivery E2E focused`

Final implementation SHA: `46dc07c104ac43b9ea52a9057e21e0771e6f7807`.

This report is committed separately as the final branch commit; its SHA is necessarily reported in the final handoff because a commit cannot contain its own hash.

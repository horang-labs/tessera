# Issue 317 agent report

## Outcome

Issue [#317](https://github.com/horang-labs/tessera/issues/317), **Prove the integrated Git delivery experience**, is complete across the browser-owned renderer and the isolated packaged-Windows titlebar. The agreed baseline was `bbf9b41a78897f8cd65e5046c5834059b35e0b49`; inherited #311-#316 commits were neither rewritten nor graded.

The integrated proof exposed and fixed these defects:

- the desktop compact commit composer did not move focus into its message field, while the phone composer must remain non-autofocused;
- action menus did not provide complete keyboard traversal, focus restoration, or a desktop menu accessible name;
- native-disabled menu rows made disabled reasons and the all-disabled pending menu unreachable to keyboard users;
- browser E2Es that exercised session WebSockets used the HTTP-only bypass instead of an isolated, signed browser identity.

The final review also expanded proof that had been too shallow: the ladder now performs Publish Branch, observes Create PR, and reaches View PR; Conflict Recovery edits the prepared AI request before proving that it is not sent and Git is not mutated.

The root rerun then exposed one integration-only focus race: a scroll-driven anchored-menu reposition replaced the `position` object and re-ran the initial-focus effect, resetting keyboard focus to Commit between arrow presses. A deterministic browser regression dispatched that reposition and failed before the fix; `6b15149ce6e3b76c1d67b3c715df86297798f450` makes initial focus depend on position readiness instead of every position object update.

No Electron process was built, launched, or spawned in the child session. The root alone performed the packaged-Windows acceptance run after all child work and browser verification were stopped.

## Acceptance mapping

| Acceptance criterion | Evidence and result |
| --- | --- |
| Dirty Commit through Pull/Publish/Push/Create PR/View PR | `tests/git-desktop-action-ladder.e2e.mjs` passed with reported ladder `commit, pull, push, publish, create_pr, view_pr`. Commit/Pull/Push/Publish use isolated real repositories/remotes; Create PR and View PR use a controlled Git snapshot plus an observed action/opened URL, so no GitHub mutation occurs. |
| Shared same-worktree state and isolated worktree | `tests/git-worktree-delivery-state.e2e.mjs` passed. Two sessions share message, exclusion, pending lock, and failure; a third session on another worktree remains editable and does not inherit failure. Late canonical identity does not overwrite a typed draft, and a clean-to-dirty transition resets correctly. This matches ADR 0001's canonical-worktree ownership. |
| Conflict recovery, AI boundary, abort, compound partial failure | `tests/git-conflict-recovery.e2e.mjs` passed real merge conflict refresh, editable prepared-only AI handoff, no send/no Git mutation, abort, and successful retry. `tests/git-desktop-action-ladder.e2e.mjs` passed Commit & Push's real commit-success/push-failure state without optimistic rollback and then recovered. |
| Desktop, medium, phone hierarchy | `tests/git-delivery-accessibility.e2e.mjs` passed at 1440×900, 900×700, and 360×776 and captured each viewport. Desktop keeps the split control, non-color diff stat, and Git panel; medium keeps adjacent visible controls without overlap; phone keeps four header controls and layered panel/sheet navigation. |
| Keyboard and accessible names | The breakpoint E2E proves primary action, diff stat, composer, menu trigger/menu/items, disabled reasons, Home/End/arrow traversal, guarded activation, Escape, and focus return. `tests/git-phone-delivery.e2e.mjs` separately proves the all-disabled pending sheet retains keyboard focus and reasons. |
| Non-color diff-stat meaning | The desktop E2E requires visible `+102 −1` symbols and the accessible label `102 additions, 1 deletion`; meaning is not color-only. |
| Complete phone contract | `tests/git-phone-delivery.e2e.mjs` passed four-control header, badge, expanded non-autofocused composer, fixed action area, bottom sheets, pending state, layered Back/Escape, and touch-target geometry. |
| Packaged Windows titlebar and isolation | PASS in a packaged Windows process with its own app identity, `data`, `user-data`, copied DB, server port 32124, and CDP 9337. At 1280 and 900 CSS px, the split control ended exactly beside the Git toggle, the toggle ended 152px before the renderer edge, and full-DPI Win32 captures visibly include the real minimize/maximize/close controls in that reserved region. |
| Browser versus Electron/topology record | Browser evidence proves renderer behavior and Git journeys. Packaged evidence proves Windows-hosted titlebar geometry, accessible split-menu behavior, and isolation; the boundaries are recorded below. |

## Commands and measured results

All servers were launched by the isolated helper after inspecting inherited Tessera environment variables. The helper removed host session/production keys, reserved unique ports, used a temporary data directory, seeded a test-only user, and stopped its exact server and browser in `finally` blocks.

| Command | Measured result |
| --- | --- |
| `gh issue view 317 --repo horang-labs/tessera --json number,title,body,url,state` | Issue OPEN; title and all ten acceptance criteria read before implementation. |
| `node tests/git-delivery-accessibility.e2e.mjs` | PASS, 23.95 s; breakpoints `[1440,900,360]`, keyboard `true`. |
| `node tests/git-desktop-action-ladder.e2e.mjs` | PASS, 54.51 s; six-state ladder, partial failure, shared owner. |
| `node tests/git-worktree-delivery-state.e2e.mjs` | PASS, 79.85 s; shared draft/failure, isolated pending, clean reset. |
| `node tests/git-conflict-recovery.e2e.mjs` | PASS, 33.78 s; merge recovery, editable prepared-only handoff, abort/retry. |
| `node tests/git-phone-delivery.e2e.mjs` | PASS, 22.74 s; 101 changed files plus pending-menu keyboard state. |
| `npx tsx --test tests/git-desktop-commit-control.test.tsx tests/git-primary-action.test.ts tests/git-action-menu.test.ts tests/git-default-branch-confirmation.test.ts tests/git-conflict-recovery.test.ts tests/git-conflict-handoff.test.ts tests/git-conflict-handoff-ui.test.tsx tests/git-abort-action.test.ts tests/git-action-failure-report.test.ts tests/git-action-report.test.ts tests/git-action-session-refresh.test.ts tests/git-panel-poll-refresh.test.ts` | PASS, 136/136 tests, 0 failures, 5.695 s. |
| `npx tsc --noEmit` | PASS, 4.08 s. |
| `npx eslint src/components/git/git-action-menu.tsx src/components/git/git-commit-form.tsx src/components/git/git-desktop-commit-control.tsx src/hooks/use-menu-navigation.ts tests/git-conflict-recovery.e2e.mjs tests/git-delivery-accessibility.e2e.mjs tests/git-desktop-action-ladder.e2e.mjs tests/git-phone-delivery.e2e.mjs tests/git-worktree-delivery-state.e2e.mjs tests/helpers/dev-server.mjs tests/helpers/git-phone-delivery.mjs` | PASS, 1.94 s. |
| `git diff --check` | PASS. |
| Root rerun of the 136-test focused command | PASS, 136/136 tests, 0 failures, 4.821 s. |
| Root `npx tsc --noEmit` plus targeted ESLint | PASS. |
| Root red/green `node tests/git-delivery-accessibility.e2e.mjs` | Before `6b15149`, deterministic failure after a synthetic anchored-menu scroll: expected `commit_push`, focus reset to `commit`. After the fix: PASS with `[1440,900,360]` and keyboard `true`. |
| `wc -l tests/git-delivery-accessibility.e2e.mjs` | 164 lines after the root regression, below the requested 190-line target. |
| Final integration `graphify update .` | PASS; 10,089 nodes, 26,774 edges, 389 communities. Graphify warned that the community set changed since the 426 saved labels and renamed 185 communities by their hub; graph integrity/output generation still completed. |

The child deliberately did not run the whole repository suite. The root's final integrated run executed all 281 unit/contract files with Node 22 `--test-force-exit`: 1,732 tests, 1,717 pass, 13 fail, 2 skip. A detached baseline worktree at pre-wave `b83c679` reproduced the same 13 failures; the wave initially added two stale narrow-refspec expectation failures, and integration commit `d86b494` updated those tests to #313's non-speculative unknown-state contract. The final integrated result therefore has zero wave-introduced full-suite regressions. Full TypeScript passed; full ESLint passed with zero errors and three pre-existing warnings.

The root also reran all five Git-delivery browser journeys sequentially on integrated HEAD. Accessibility/breakpoints, six-step ladder and compound partial failure, same-worktree sharing/isolation, conflict recovery/AI handoff, and phone delivery all passed.

## Browser breakpoint and screenshot evidence

All screenshots were visually inspected. Paths are supplied as Windows-accessible WSL UNC paths, followed by SHA-256.

- Desktop, 1440×900: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-317\desktop-git-delivery.png` — `c59bc361b620360b33309fd02092979c33249fccd4eadb1993fdea998b568830`
- Medium, 900×700: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-317\medium-git-delivery.png` — `ac002a030cea52ec0c9d31e681aba0af320f7740eb5f7d384bae07c182c81951`
- Phone, 360×776: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-317\phone-git-delivery.png` — `b9fe543a404c82b6d91bab24efb9c358ea93c3165806af038ba14a541d58dcf1`
- Commit & Push partial failure, 1440×900: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-313\partial-push-failure.png` — `1d6e1d93d6a07be08f1cd98c44ee56edc1660e4cec44e50158ea96ef742cfa36`
- Same-worktree shared failure, 1280×800: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-311\shared-failure.png` — `29cd4ec169a9218df03f7e2202d9f8c2696c5f8b4e2c32ab714d53a6273671a9`
- Conflict/AI handoff, 1440×900: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-315\conflict-handoff.png` — `37e1325767713ab6404e7756f61013fd16c8477b2f1658bf6347d63ed890aabc`
- Phone fixed composer, 360×776: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-316\phone-fixed-composer.png` — `b4038aa80374f7bfcbc7aee1ef7502ab69ad3a006eb0f4271302a855eeb64e25`
- Phone action sheet, 360×776: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-316\phone-action-sheet.png` — `dbff67540580de448cc8bb6af574c053f03a0ba0d1339449e9bfffc02fefa95d`
- Phone pending badge, 360×776: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-316\phone-pending-badge.png` — `bee9d537ea218730e9e94cec5606cb9ed417a7fab7c90ab514d05b1f876a66ef`
- Packaged Windows desktop, 1280×800 CSS / 1920×1200 physical at 150% DPI: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-317-packaged-dpi\desktop-1280-native.png` — `c76841136b25b481ba076fb1dbd891d30b87cdbcf52c242ff68ec4aed6a20971`
- Packaged Windows medium, 900×700 CSS / 1350×1050 physical at 150% DPI: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-317-packaged-dpi\medium-900-native.png` — `d91602f0692fcbdf268c5eae9afbebe5dbbd58a82cf7936a79a4013ccf669f67`

## Packaged Windows Electron evidence

The root built branch `feature/0809-t317` as a Windows x64 package and launched only the copied unpacked executable `C:\Users\work\Downloads\Tessera-issue-317-titlebar-20260810-unpacked\Tessera.exe`; the portable handoff SHA-256 was `706181161e02c681b1056db30ebe363dce4e25fd24808a509768d3b4028f01dd` and the launched executable SHA-256 was `21a5196e40e7b2186923db8ac78c2ee30f9fd05d94d18a0b91e7c5265c802f83`. `TESSERA_DEV_PORT` remained unset, so the packaged Windows app forked its own Windows server rather than reusing a WSL dev server.

Isolation facts:

- Installed app invariant before and after: Windows PID 47528 on port 32123; Control instance `29eaa68d-6a92-49d8-857b-58dc29c80b01` remained `connected`.
- Test namespaces used unique instance roots under `C:\Users\work\AppData\Local\TesseraTestInstances\codex-0810-t317-*`, each with separate `data` and `user-data`; no test instance reused the installed profile.
- Test server/CDP used 32124/9337 while active. Both ports were closed after each ownership-manifest stop; afterward only PID 47528/32123 remained.
- Source seed DB `/home/work/.tessera/tessera-dev.db` SHA-256 stayed `a0f60eff5b506a90c99085457c93f6ea1824c25ac55fbfd4a95070bfe1073961` before and after. Each isolated database reported the same hash because it was a copied snapshot, not the same file.
- Windows CDP reached `http://localhost:32124/chat`, title `Tessera`, ready state `complete`. No child CLI session or Git action was started inside the packaged app.
- At 1280 CSS px, split control `[967.23,1088.00]`, Git toggle `[1088,1128]`, viewport width 1280, reserved native inset 152. At 900 CSS px, split control `[587.23,708.00]`, Git toggle `[708,748]`, viewport width 900, reserved native inset 152. Both widths had positive control geometry, exact adjacency without overlap, complete accessible names, menu keyboard activation, Escape close, and trigger focus return.
- Full-DPI Win32 captures visibly show the split control, Git toggle, and real minimize/maximize/close controls together. The initial logical-pixel capture cropped the physical right third at 150% DPI; the final evidence uses `DWMWA_EXTENDED_FRAME_BOUNDS`, producing the correct 1920×1200 and 1350×1050 physical images listed above.
- Three short sequential isolated manifests were used while correcting that evidence capture: functional CDP/geometry, an inconclusive classic DWM caption-bounds probe, and the final DPI-correct native capture. They never overlapped and each was stopped immediately by its exact ownership manifest. No broad process or port termination was used.

## Topology limitations

The browser journeys used isolated WSL/Linux Next servers and headless Chromium. They prove renderer behavior, real local Git/remotes, WebSocket-authenticated session state, breakpoints, and accessibility, but not Windows `win32` branches or packaged titlebar/profile behavior. The root packaged run separately proves the Windows server/runtime, native titlebar inset and visible window-control geometry, CDP renderer behavior, and packaged profile/database separation. It does not repeat the full Git mutation ladder; that remains the browser suite's controlled responsibility. Create PR/View PR used controlled HTTP snapshots and observable renderer actions rather than GitHub network mutation. These are deliberate topology boundaries.

## TDD seams

Public seams were driven red/green at the UI and API boundary:

- the new breakpoint journey first failed because the desktop menu had no accessible name; it passed after menu semantics, focus traversal, disabled-reason reachability, and focus return were implemented;
- WebSocket journeys first exposed repeated authentication failure when only the HTTP test bypass was present; the test harness was corrected to seed a test user and sign the same browser JWT used by production authentication, without weakening runtime auth;
- the final green browser seams exercised real rendered controls and observable Git/API effects, not component internals;
- focused unit seams remained green at 136/136 after the integration fixes.

## Independent code review

Both axes reviewed `git diff bbf9b41a78897f8cd65e5046c5834059b35e0b49...HEAD` and made no edits.

Initial Standards review: 0 hard violations; three judgment findings—duplicate menu traversal instead of `useMenuNavigation`, duplicate screenshot helper, and duplicated browser identity defaults. All three were fixed. Final Standards review: 0 hard violations, 0 judgment findings, no actionable findings.

Initial Spec review: four findings—ladder stopped before Publish/Create PR/View PR; disabled/pending reasons were keyboard-inaccessible; desktop menu lacked an accessible name; editable AI handoff was not proven. All four were fixed. Final Spec review: no actionable findings; all acceptance criteria in this child's scope pass, with packaged Electron correctly reserved for the root.

## Commit ledger

- Start: `bbf9b41a78897f8cd65e5046c5834059b35e0b49`
- Implementation and initial evidence: `d9bb0a4` (`fix(git): harden integrated delivery journey`)
- Review fixes and expanded evidence: `dd1605d48f719866b92cac23752baac85a3216fc` (`fix(git): close integrated delivery review gaps`)
- Root-discovered reposition focus race and regression: `6b15149ce6e3b76c1d67b3c715df86297798f450` (`fix(git): preserve action menu focus on reposition`)
- Root integration-only stale expectation cleanup: `d86b494` (`test(git): align narrow refspec with unknown ladder`)
- This report is committed separately; its containing SHA is available with `git log -1 --format=%H -- agent-report-317.md` and is reported to the root after creation (a commit cannot contain its own SHA without a self-reference cycle).

## Deliberately excluded scope

- no Electron build, launch, spawn, or packaged-Windows claim in the child; all packaged evidence was root-owned after the child stopped;
- no installed-app, production database, user profile, user data, or production-port access;
- no whole-repository suite;
- no push, PR creation, issue comment, merge, issue close, or other GitHub mutation;
- no rewriting or grading of inherited #311-#316 commits;
- no product changes outside integration defects exposed by issue #317 proof.

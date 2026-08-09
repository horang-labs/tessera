# Issue 317 agent report

## Outcome

Issue [#317](https://github.com/horang-labs/tessera/issues/317), **Prove the integrated Git delivery experience**, is complete for the browser-owned renderer and Git-delivery scope. The agreed baseline was `bbf9b41a78897f8cd65e5046c5834059b35e0b49`; inherited #311-#316 commits were neither rewritten nor graded.

The integrated proof exposed and fixed these defects:

- the desktop compact commit composer did not move focus into its message field, while the phone composer must remain non-autofocused;
- action menus did not provide complete keyboard traversal, focus restoration, or a desktop menu accessible name;
- native-disabled menu rows made disabled reasons and the all-disabled pending menu unreachable to keyboard users;
- browser E2Es that exercised session WebSockets used the HTTP-only bypass instead of an isolated, signed browser identity.

The final review also expanded proof that had been too shallow: the ladder now performs Publish Branch, observes Create PR, and reaches View PR; Conflict Recovery edits the prepared AI request before proving that it is not sent and Git is not mutated.

No Electron process was built, launched, or spawned in this child session. The remaining packaged-Windows titlebar acceptance check belongs exclusively to the root orchestrator.

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
| Packaged Windows titlebar and isolation | Deferred only to the root orchestrator as explicitly required. The exact handoff is below. |
| Browser versus Electron/topology record | Browser evidence and limitations are separated below; this child performed no Electron work. |

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
| `wc -l tests/git-delivery-accessibility.e2e.mjs` | 155 lines, below the requested 190-line target. |
| `graphify update .` | PASS, 22.27 s; 10,077 nodes, 26,763 edges, 429 communities. |

The whole repository suite was deliberately not run; the root orchestrator owns the final integrated suite.

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

## Packaged Windows Electron handoff for the root

Run exactly one short, isolated packaged-Windows instance using `.claude/notes/electron-isolated-test.md`; stop it immediately after evidence capture. Do not set `TESSERA_DEV_PORT`, because that would leave the server in WSL and would not exercise the reported Windows topology.

The root must verify and record:

1. unique application identity, profile/user-data directory, database/data directory, ports, and process tree; none may resolve to the installed app or production data;
2. a genuinely Windows-hosted packaged server/runtime, not a Linux dev server behind a Windows-looking window;
3. at representative desktop and medium widths, the header split commit control fits beside native window controls and the existing Git-panel toggle without clipping, overlap, or blocking titlebar drag/window controls;
4. keyboard focus/activation and complete accessible names for the split control at those widths;
5. screenshot paths, dimensions, hashes, exact widths, and teardown confirmation.

## Topology limitations

The browser journeys used isolated WSL/Linux Next servers and headless Chromium. They prove renderer behavior, real local Git/remotes, WebSocket-authenticated session state, breakpoints, and accessibility, but cannot prove Windows `win32` branches, packaged resource/protocol behavior, native titlebar inset/window-control geometry, or packaged profile/database separation. Create PR/View PR used controlled HTTP snapshots and observable renderer actions rather than GitHub network mutation. These are deliberate topology boundaries, not untested browser claims.

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
- This report is committed separately; its containing SHA is available with `git log -1 --format=%H -- agent-report-317.md` and is reported to the root after creation (a commit cannot contain its own SHA without a self-reference cycle).

## Deliberately excluded scope

- no Electron build, launch, spawn, or packaged-Windows claim in this child;
- no installed-app, production database, user profile, user data, or production-port access;
- no whole-repository suite;
- no push, PR creation, issue comment, merge, issue close, or other GitHub mutation;
- no rewriting or grading of inherited #311-#316 commits;
- no product changes outside integration defects exposed by issue #317 proof.

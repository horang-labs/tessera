# Agent report — GitHub issue 302

## Outcome

Implemented optional PWA installation guidance for approved Paired Devices.

- Added a stable Tessera web app manifest, 192px/512px application icons, Apple web-app metadata, and npm package inclusion for the icons.
- Added an authenticated, same-origin service-worker registrar and a minimal `/sw.js` that only calls `skipWaiting()`/`clients.claim()` and has no fetch or Cache Storage behavior.
- Changed the successful pairing handoff to `/install` unless this origin has already completed/dismissed the guidance or is already running in standalone mode.
- Added mobile-first install, browser-continue, prompt-dismissed, installed, unsupported-browser, iOS/iPadOS version, and Safari-only paired-flow states in all four existing locales.
- Added early `beforeinstallprompt` capture so authentication cannot race and lose the one-shot browser event.
- Kept iOS/iPadOS 17.2+ paired Home Screen guidance specific to Safari; earlier versions and other iOS browsers remain usable without making an invalid credential-transfer claim.

The service worker deliberately has no `fetch` handler and never opens or writes Cache Storage, because authenticated HTML, APIs, sessions, credentials, and offline mutations must remain network-only.

## Provider skill and TDD seams

The provider implementation skill was invoked by loading `/home/work/.agents/skills/implement/SKILL.md` and treating GitHub issue 302 as its supplied ticket. It required `/tdd`, regular targeted tests/typechecking, `$code-review`, and a commit.

The pre-agreed public seams came directly from the issue's browser-test acceptance criterion:

1. **Manifest/service-worker HTTP and browser seam** — red: `/manifest.webmanifest` returned 404 HTML and failed JSON parsing. Green: actual manifest identity/icons loaded, the registered worker reported origin-root scope, and authenticated fetches left `caches.keys()` empty.
2. **Installation-state browser seam** — red: `/install` had no `pwa-install-ready` UI. Green: optional install/continue, prompt dismissal, repeat visit, installed display mode, iOS 17.1, iOS/iPadOS 17.2 Safari, iOS 17.2 Chrome, and desktop escape behavior passed.
3. **Approved-pairing handoff seam** — red: the existing pair-page E2E timed out waiting for `/chat` after the implementation correctly reached `/install`. Green: the test now observes `/install`, chooses browser use, reaches `/chat`, and confirms repeat entry skips the completed guidance.

Tests only observe public HTTP/browser interfaces. The synthetic install-prompt object is a browser-boundary input; application internals are not mocked.

## Verification

- `gh issue view 302 --repo horang-labs/tessera --json number,title,body,state,labels,assignees,url,comments` — issue and all eight acceptance criteria loaded. The default unfiltered `gh issue view` first failed on GitHub's removed Projects Classic `projectCards` field; the explicit JSON request succeeded.
- `TESSERA_E2E_HEADED=0 node tests/pwa-installation.e2e.mjs` — exit 0. Measured: manifest identity true; worker scope was the test origin root; optional install true; repeat and installed visits skipped; authenticated Cache Storage keys `[]`; iOS 17.1 unsupported; iOS 17.2 Safari guided; desktop-UA iPadOS 17.2 guided; iOS 17.2 Chrome unsupported; desktop browser escape reachable.
- `node tests/pair-page.e2e.mjs` — exit 0. Approved pairing, persistent device cookie, local approval, denial/rotation/error states, `/install` handoff, browser continuation, and repeat `/chat` entry passed.
- `npx tsc --noEmit` — exit 0, no diagnostics.
- `npm run lint` — exit 0 with 0 errors and 3 pre-existing warnings in `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`; no warning was introduced by issue 302.
- `NODE_ENV=production npm run build` — exit 0. Webpack compiled in 30.4s, TypeScript in 12.0s, 49 static pages generated; `/install`, `/manifest.webmanifest`, and `/sw.js` appeared in the route table.
- `npm pack --dry-run --ignore-scripts --json` — both PNG icons and the built manifest/service-worker routes were present in the npm file list.
- `graphify update .` — code graph refreshed to 10,024 nodes, 26,565 edges, and 371 communities. Graphify reported that community labels could be refreshed separately; no LLM extraction was required.
- `git diff --check` / `git diff --cached --check` — no whitespace errors.

Headless diagnostic screenshots were captured at the cross-platform, overrideable artifact directory `~/tmp/tessera-pwa-installation-e2e/` (`install-ready-headless.png` and `ios171-headless.png`). They were inspected for gross clipping but are not claimed as headful visual evidence.

## Runtime-specific review and limitations

`DISPLAY=:99 xdpyinfo` reported that the designated isolated X display was unavailable. Per the ticket rules, no user-visible WSLg fallback was attempted. Therefore headful visual correctness and real compositor geometry were not verified. Functional browser tests ran explicitly headless; their screenshots do not replace headful evidence.

The existing packaged-Electron pairing E2E expectation was updated to pass through `/install`, but it was not run: this ticket changes same-origin browser/PWA behavior and does not require the Windows-backend/WSL-CLI topology. A real OS installation prompt and launch from an installed Home Screen icon were not automated; the manifest, icons, worker registration/scope, early prompt event path, standalone detection, and all guidance choices were automated instead.

The full test suite was deliberately not run because the wave orchestrator explicitly reserves that decision for the integrated state.

## `$code-review` invocation and findings

Fixed point: `feature/0809-t298` (`2c82c533ce6830749c6b0ba9f2cd5929f36d19ad`). Review diff: `git diff feature/0809-t298...HEAD`. Commit list at invocation: `e61e49c feat: guide paired devices through PWA installation (#302)`.

The supplied `$code-review` skill ran its two read-only agents in parallel:

- **Standards — 1 hard finding:** hard-coded `/home/work/tmp/...` screenshots violated `CONTRIBUTING.md` cross-platform support. Fixed with `TESSERA_E2E_ARTIFACT_DIR` plus a created per-user `~/tmp` default. No decision-relevant baseline smell remained.
- **Spec — 2 findings:** all iOS 17.2+ browsers were incorrectly shown Safari guidance, and `beforeinstallprompt` could fire before the post-auth listener. Fixed by Safari-specific detection plus an explicit unsupported state for other iOS browsers, parser-time prompt capture, and regression cases for pre-auth prompt delivery and iOS Chrome.

No spec scope creep was reported. All three valid findings were applied and the targeted E2E, lint, typecheck, and production build were rerun successfully afterward.

## Commit

Implementation commit: `0f758d4d2266deb5a360070cd0343480a4472e81` (`feat: guide paired devices through PWA installation (#302)`). This report is committed in the following documentation-only commit, whose own hash cannot be self-recorded inside its contents.

## Deliberately left out

- No authenticated/offline caching, offline mutations, background sync, or fallback page.
- No Push subscription, permission prompt, or notification delivery work from later parent-issue tickets.
- No changes to Tailscale Serve ownership/setup from blocking issue 298.
- No rewrites or grading of commits inherited from `feature/0809-t298`.
- No dependency upgrades, broad UI refactors, push, PR, or issue state changes.

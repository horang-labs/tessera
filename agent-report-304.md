# Issue 304 implementation report

## Outcome

Implemented GitHub issue `horang-labs/tessera#304` from fixed point
`feature/0809-t303` (`8ae2c6547e754e5d41e335544b333b0e547211b3`) without modifying
inherited commits.

Session Notifications now use one server-issued event ID for WebSocket and Web Push delivery.
The eligible kinds are completed, input required, permission request, ask-user question, and
plan approval. Errors, action feedback, rate limits, cached/replayed state, and unrelated
transport events remain ineligible.

The browser uses one bounded recent-event set (100 IDs) for WebSocket and service-worker
delivery. A visible same-origin client receives an in-app notification without an OS banner;
otherwise the service worker creates exactly one navigation-only notification. Clicking it
focuses or opens the same-origin session URL, including the current prompt where available.
All five kinds share validated titles, previews, fallbacks, URL construction, and the 2,048-byte
Push payload bound. Terminal `completed`/`input_required` states participate when live, while a
runtime restart's cached `lastState` is explicitly replay-only and cannot create an event ID or
schedule Push.

Settings copy in English, Korean, Japanese, and Chinese now describes Session Notifications
rather than completed-task-only delivery.

## Implementation skills and TDD

The user invoked the provider implementation workflow explicitly as `$implement`. I loaded its
`SKILL.md`, treated issue 304 as the supplied ticket, and ran every implementation change through
the `/tdd` workflow it requires. The two main test seams were:

- server delivery: `WebSocketServer.sendToUser`, including identical WebSocket/Push event IDs,
  terminal state eligibility, and replay suppression;
- browser delivery: the real WebSocket message handler and service-worker page-message entrypoint,
  plus the generated service worker's `push` and `notificationclick` handlers.

Measured red/green checkpoints:

- Initial focused RED: 12 tests, 6 passed and 6 failed (missing shared presenter, only completed
  eligible, missing event IDs, and missing foreground forwarding/fallback behavior).
- First review-fix RED: 11 tests, 9 passed and 2 failed (live terminal input-required delivery and
  real-entrypoint coverage). Focused GREEN: 50/50.
- Replay-fix RED command also loaded the repository's broader `terminal-contract` file: 68 tests,
  59 passed and 9 failed. The two new assertions failed as intended (no replay marker and one Push
  scheduled instead of zero); seven unrelated pre-existing contract assertions also failed. The
  new replay coverage was moved into the focused Push contract. Focused GREEN: 10/10.
- Final targeted GREEN: 58/58.

## Review

Loaded and invoked `$code-review` exactly as supplied. Its two explicitly authorized agents ran
in parallel against `feature/0809-t303...HEAD`, limited to acceptance gaps and hard documented
standards violations.

Initial Spec findings were valid and applied:

1. live terminal `session_state: input_required` did not reach Push;
2. tests did not prove the exact shared WebSocket/Push ID or exercise both actual page entrypoints.

The first Spec rerun found one additional valid gap: terminal runtime restart replayed cached
`lastState` through the live Push seam. That path now carries `{ replay: true }`, suppressing both
ID creation and Push scheduling while retaining WebSocket state recovery.

The final review was rerun after the browser E2E harness change. Results:

- Standards: no hard documented-standard violations.
- Spec: no remaining acceptance-criteria gaps; the reviewer confirmed the registered service
  worker's real `push` handler remains covered.

## Verification commands and measured results

Issue and fixed point:

```text
gh issue view 304 --repo horang-labs/tessera
```

The bare command reached GitHub but `gh` emitted its known deprecated `projectCards` GraphQL
warning, so the issue was read successfully with:

```text
gh issue view 304 --repo horang-labs/tessera --json number,title,body,url,labels,state
git rev-parse feature/0809-t303
# 8ae2c6547e754e5d41e335544b333b0e547211b3
```

Dependencies and graph orientation:

```text
npm ci
# 1,050 packages installed; npm reported 46 audit findings. No audit fix was run.

graphify query "session notification push delivery event dedupe websocket service worker permission plan question" --budget 6000
graphify update .
# final update: 10,123 nodes, 26,804 edges, 425 communities; exit 0
```

Final targeted tests:

```text
node --import tsx --test --test-force-exit \
  tests/web-push-contract.test.ts \
  tests/web-push-service-worker.test.ts \
  tests/session-notification-presentation.test.ts \
  tests/notification-store-dedup.test.ts \
  tests/terminal-session-runtime-state.test.ts \
  tests/title-generation-settings.test.ts
# 58 tests, 58 passed, 0 failed, 678.016883 ms; exit 0

npx tsc --noEmit
# exit 0, no diagnostics

npm run lint
# exit 0; 0 errors, 3 pre-existing warnings:
# preview-markdown.tsx no-img-element
# use-virtual-message-list.ts incompatible-library
# spawn-cli-runtime.ts unused eslint-disable

git diff --check
# exit 0
```

The new browser E2E is 126 lines, below the requested 200-line limit. On the first attempt the
isolated app had no advertised pairing address, exposing a test setup bug. After that was fixed,
the browser did not expose the `ServiceWorker.enable` CDP domain. The final harness dispatches an
actual `PushEvent` in the registered service worker instead:

```text
DISPLAY=:99 TESSERA_E2E_HEADED=1 \
  TESSERA_E2E_ARTIFACT_DIR="$PWD/artifacts/issue-304" \
  node tests/web-push-notification.e2e.mjs
# exit 0
# permissionCallsBeforeAction: 0
# deniedKeepsAppUsable: true
# backgroundNotificationCount: 1
# clickUrl: http://127.0.0.1:38055/chat?session=session-1&prompt=tool-1
```

The helper stripped inherited host-session variables, used a free loopback port and a temporary
data directory, and stopped only its own detached process group. The visual permission-denied
state is captured in `artifacts/issue-304/permission-denied.png` (132,471 bytes, SHA-256
`2b73b2547680a4eca672852ef0e910a38be77956e8edac3b4733b6dfa6d286b5`).

## Isolated Windows Electron evidence

Following the `tessera-electron-dev` workflow and the cross-boundary notes, I built and launched
one isolated packaged Windows app beside the installed app:

```text
bash "$PWD/.codex/skills/tessera-electron-dev/scripts/build_and_launch.sh" \
  --repo "$PWD" --count 1 --session-id "codex-304-push-0809-2150"
```

Measured result: Next production build succeeded (50 routes), Electron prepare/package succeeded,
isolated server port `32125`, CDP port `9338`, PID `48572`. The portable artifact SHA-256 was
`2a965d7db9f5d121a5e9489ea4bd6ac3bff0c4f2a5774c3270642eb38ffdfb34`; the unpacked executable
SHA-256 was `dcfda4cb7bce1fe38726967efbf0e92339d762fecacc9f4049e8ec87716e79fe`.

Through the packaged renderer's actual service-worker page entrypoint, a foreground Push appeared
in Tessera's notification center. Re-delivering the same event ID after the WebSocket path left the
presentation count at `1 -> 1`. The inspected screenshot is
`artifacts/issue-304/electron-foreground.png` (203,860 bytes, SHA-256
`dd221a1e4a6a38644052f01a8722b86a5a4431524c315b4d182b9a86476642de`).

The isolated runtime was stopped with its generated stop manifest; only PID 48572 was stopped and
its isolated data root was removed. Ports 32125/9338 closed, the installed app remained listening
on 32123 (PID 33516), and the original Tessera database hash remained unchanged. Generated portable,
unpacked, and build artifacts were moved to trash (recoverable); the two evidence screenshots were
retained in this worktree.

This packaged Electron run was made after the first implementation commit and before review fixes.
The later fixes affect terminal replay classification and the test harness; they were verified by
the final unit/integration and headful browser runs, but the Windows portable was not rebuilt.

## Commits

Code-complete HEAD before this report:

`ac331fdb341b6faaf6d5aacc1bd812517d21f7dd`

Ticket commits:

- `d1f947d7e345a6f5e85e41da126946d6688ab006` — core Session Notification delivery and dedupe;
- `a40336c03d589085c482acd19795ac760ed6d967` — terminal delivery and actual entrypoint coverage;
- `0495eb432841bc05f7e23b69758842210d042acf` — cached terminal replay suppression;
- `ac331fdb341b6faaf6d5aacc1bd812517d21f7dd` — headful browser delivery harness.

## Not verified or deliberately left out

- No real third-party Web Push endpoint/provider was contacted; provider success/failure is covered
  deterministically at the dispatcher seam.
- Packaged Electron background OS-banner enumeration/click could not be driven because its CDP target
  did not expose the required service-worker domain. Final headful Chromium E2E covers exactly one
  background notification and click navigation through the registered worker.
- The full suite was not run, per the orchestrator instruction.
- Expired-endpoint cleanup, delivery retries/outbox semantics, per-kind settings, and OS notification
  actions were not added because issue 304 does not request them (and actions are explicitly excluded).
- No inherited blocker commits were changed. Nothing was pushed and no pull request was opened.

# Issue 303 implementation report

## Outcome

Implemented the complete paired-device Web Push tracer bullet from GitHub issue #303 on top of
`feature/0809-t302` (`f147be930843816d5fdad4d3f8414406587b2945`). The code-complete commit is
`236de88ef8442aa3e48e5a503bec63e2cb26cca1`; the initial implementation commit is
`418227392c670a150160b0f04eb6884bf189faae`.

## What changed and why

- Added a per-install VAPID identity store under the Tessera data directory. It writes through a
  uniquely named temporary file, applies owner-only permissions before publication, atomically
  renames, and reapplies owner-only permissions to the destination. POSIX uses `0700`/`0600`;
  Windows uses a protected current-user-only ACL. The existing mobile-access persistence now uses
  the same owner-only path helper so the security rule has one implementation.
- Extended the paired-device registry with an optional validated Push subscription and added a
  paired-device-only `GET`/`PUT`/`DELETE /api/push/subscription` contract. Device identity comes
  only from the authenticated cookie, so a body-supplied device id cannot select another device.
- Added one global `notifications.pushEnabled` setting, normalized to `true` for old and new
  settings. Disabling it skips delivery without touching registered subscriptions.
- Added installed-PWA controls to Remote Access settings. Capability/installation checks happen
  without prompting; `Notification.requestPermission()` is called only by the explicit enable
  button. Denial and unsupported/non-installed states do not block the rest of Tessera.
- Classified completed notifications at `WebSocketServer.sendToUser`. WebSocket recording and
  delivery remain synchronous while Web Push is scheduled best-effort. Missing subscriptions,
  disabled Push, settings errors, and delivery failures do not block the WebSocket path.
- Reused the existing completion message and preview, added deterministic UTF-8 payload limits
  (2,048-byte total), completed fallbacks, and a same-origin session URL.
- Added service-worker background display, visible-window suppression, exactly-one notification
  behavior, and click focus/navigate/open behavior. Chat consumes `?session=` and selects the
  referenced session once it is available.
- Added contract, service-worker, and browser e2e coverage. The new e2e file is 127 lines.

## Skill and TDD execution

The ticket was supplied directly to `$implement`. Its `/tdd` seam ran for:

1. Paired-device API and VAPID persistence: the first run failed because the Push modules/routes
   did not exist; the ownership test then exposed a `403` test-origin mismatch and a spoofed
   `deviceId` echo. The fixture origin and structural-copy leak were fixed before green.
2. Server send-to-user dispatch: tests first characterized completed-only classification, global
   suppression, missing subscriptions, size limiting, and non-blocking failures, then the
   dispatcher was connected at `sendToUser`.
3. Service-worker events: three handler tests (background display, visible suppression, click
   routing) were red before the handlers existed and green after implementation.
4. Windows owner-only storage: the Windows ACL contract was red before the VAPID store was
   injectable/exported, then green together with the pre-existing mobile-access ACL test.

Graph orientation used `graphify reflect --if-stale`, a vocabulary query for
`notification paired device registry service worker pwa websocket`, and targeted source reads.
After code changes, `graphify update .` completed successfully; the post-review update reported
no code-graph topology changes.

## Commands and measured results

Issue read:

```text
gh issue view 303 --repo horang-labs/tessera
```

This command failed because GitHub's response included a retired Projects Classic field. The
read-only fallback `gh api repos/horang-labs/tessera/issues/303 --jq
'{title,body,labels:[.labels[].name],state}'` succeeded and supplied the issue specification.

Final targeted test command (run after review fix):

```text
node --import tsx --test --test-force-exit \
  tests/web-push-contract.test.ts \
  tests/web-push-service-worker.test.ts \
  tests/title-generation-settings.test.ts \
  tests/mobile-access-coordinator.test.ts \
  tests/pairing-approval.test.ts
```

Result: 22 tests, 22 passed, 0 failed, 0 skipped, 2.59 seconds. This includes subscription
ownership, owner-only persistence, global suppression, missing subscriptions, asynchronous
failure, the no-WebSocket send seam, background display, visible suppression, and click routing.

```text
npx tsc --noEmit
```

Result: exit 0 (4.16 seconds on the final run).

```text
npm run lint
```

Result: exit 0, 0 errors and 3 warnings (about 33.3 seconds). All warnings are pre-existing and
outside this ticket: `preview-markdown.tsx` (`no-img-element`),
`use-virtual-message-list.ts` (React Compiler incompatible library), and
`spawn-cli-runtime.ts` (unused eslint-disable).

```text
git diff --check
```

Result: exit 0.

No full test suite was run, as required by the wave instructions.

## Windows Electron / cross-boundary verification

The packaged Windows-server + WSL-CLI topology was exercised with the repository's
`tessera-electron-dev` workflow after reading all three required cross-boundary notes.

```text
bash "$PWD/.codex/skills/tessera-electron-dev/scripts/build_and_launch.sh" \
  --repo "$PWD" --count 1 --session-id "codex-303-push-0809-2104"
```

Result: Next production compilation succeeded (80 seconds), TypeScript build phase succeeded
(10.7 seconds), 50 routes were generated, and Electron compile/preparation/portable packaging
succeeded. The portable artifact SHA-256 was
`93293126185c365a9316546ccc3d57d71e2532dd4e5e2d75a1d8b23ca48524ba`; the unpacked launch
executable SHA-256 was `c0e8f1251fa9abdbadd1de75ff8f0cb22eaf4273eccd159e98aab94805353180`.
The isolated instance used Windows PID 14152, server `http://localhost:32124`, CDP
`http://127.0.0.1:9337`, and a dedicated data directory under
`C:\Users\work\AppData\Local\TesseraTestInstances\codex-303-push-0809-2104`.

A Windows Node smoke probe against that packaged server paired a real device, replaced/read/deleted
its subscription, read only the public VAPID key, toggled global Push off and on, and re-read the
subscription after each toggle. Measured result:

```json
{
  "packagedServer": true,
  "pairedOwnershipRoundTrip": true,
  "privateKeyExposed": false,
  "vapidPublicKeyLength": 87,
  "globalSuppressionRetainsSubscription": true,
  "globalPushEnabledAfterResume": true
}
```

PowerShell ACL inspection of `push\vapid-identity.json` measured protected inheritance with exactly
one allow rule, `window\work: FullControl`, and zero temporary files. Electron CDP confirmed the
Remote Access Push setting rendered checked and without clipping. The screenshot is retained at
`\\wsl.localhost\Ubuntu-24.04\home\work\tmp\t303-push-settings.png` (SHA-256
`d3fba04f5ed1a0ce99e89817799e478d9df3f05d566aab208a1d1f924bc0afa3`).

Cleanup used:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass \
  -File "$(wslpath -w "$PWD/scripts/stop-electron-test-session.ps1")" \
  -SessionId codex-303-push-0809-2104 -RemoveData
```

It stopped only PID 14152, removed the isolated data and ownership manifest, and closed ports
32124/9337. The test portable/unpacked artifacts were moved to trash after their hashes were
recorded. The user's installed app/server remained alive (PIDs 44248/33516, port 32123). The two
production DB hashes were unchanged before/after:

- `tessera-dev.db`: `e3271c7dc7a9ef4babfc82be8bb84e2c50ae0828f59509097c1e360fbea9c380`
- `tessera.db`: `8095eae016a1675fc896f2d95477865f6d7c00b8dff6221f1302847bad58a54c`

## Code review

`$code-review` was invoked exactly with fixed point `feature/0809-t302`, diff command
`git diff feature/0809-t302...HEAD`, and commit list command
`git log feature/0809-t302..HEAD --oneline`. Its authorized parallel review agents were
`/root/review_303_standards` and `/root/review_303_spec`; both were review-only.

### Standards

One hard finding: `web-push-dispatcher.ts` logged the full Push endpoint, which can be a
capability URL and would violate `CONTRIBUTING.md`'s sensitive-log rule. Fixed by removing the
endpoint from the warning context in commit `236de88`. A judgement-only possible duplication in
the two atomic owner-only persistence flows was not elevated under the ticket's review threshold.
No other documented-standard violation was found.

### Spec

No acceptance-criteria gaps, incorrect implementations, or prohibited scope expansion were found.

Summary: Standards 1 actionable finding (fixed; worst: sensitive capability URL logging); Spec 0
findings (no worst issue).

## What could not be verified

- The designated isolated Linux X display was unavailable:
  `DISPLAY=:99 xdpyinfo` exited 1 with `unable to open display ":99"`. One attempted headful launch
  immediately failed with Chromium's `Missing X server` error before assertions ran. Per policy,
  there was no headless or user-visible WSLg fallback, so
  `tests/web-push-notification.e2e.mjs` was not counted as executed browser evidence.
- No real third-party Push service endpoint/browser subscription was contacted. Delivery payload,
  failure isolation, service-worker display, and click behavior are verified through contracts and
  the service-worker harness; the packaged runtime verified the server/storage/API boundary.

## Deliberately left out

- No product-wide VAPID key, relay, durable outbox, replay, notification response actions, or
  Push kinds other than completed.
- No per-device or per-kind settings and no API for enumerating another device's subscription.
- No broad refactor to extract the review's judgement-only duplicate atomic-write shape.
- No changes to commits predating this session, no full-suite run, no push, and no pull request.

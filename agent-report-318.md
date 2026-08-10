# Issue 318 implementation report

## Outcome

Implemented GitHub issue #318 on top of `61db1ac97ec5a5666f09350db19b2a5a23efa6b0`.
The code and targeted regression test are committed as
`9c038a1288b9769e13006c51065d826e575176de` (`fix: prioritize session notification web push
(#318)`).

## What changed and why

- `createWebPushDispatcher` now supplies `{ TTL: 300, urgency: 'high' }` at its injected
  `sendNotification` seam for every eligible Session Notification Push. The existing five-minute
  retention period is therefore preserved while the push service is asked to prioritize delivery.
- The production adapter forwards those request options unchanged to `web-push`. VAPID setup,
  payload construction, best-effort failure handling, permanent 404/410 rejection handling, and
  subscription cleanup were not changed.
- Added a focused dispatcher contract test that observes the exact TTL and urgency values at the
  injected send seam. The existing cleanup contract remains in the same targeted test file and
  passed unchanged.

## Skill and TDD execution

The user supplied issue #318 directly to `$implement`; the implementation skill was read and
invoked as the owner of the full implementation, verification, review, report, and commit loop.

The pre-agreed `/tdd` seam was the public dependency boundary returned by
`createWebPushDispatcher`: `sendNotification(subscription, payload, options)`. The issue itself
required automated observation "at the `web-push` dispatcher seam", so no additional seam choice
was inferred. One vertical slice ran through red then green:

1. The new test expected `{ TTL: 300, urgency: 'high' }` and failed with actual `undefined`.
2. The dispatcher dependency contract gained `RequestOptions`, the dispatcher supplied the two
   required options, and the production adapter forwarded them to `webPush.sendNotification`.
3. The focused test passed, followed by the complete targeted Push contract file. Existing tests
   continued to cover expired subscription removal, permanent 410 cleanup, and retention of
   transiently failing subscriptions.

Graph orientation used `graphify reflect --if-stale`, an audited vocabulary expansion to
`[push, notification, dispatcher, subscription]`, `graphify query`, and `graphify explain` before
direct source reads. `graphify update .` then rebuilt the code graph successfully: 10,293 nodes,
27,086 edges, and 383 communities. It left no tracked graph output changes.

## Commands and measured results

Issue read:

```text
gh issue view 318 --repo horang-labs/tessera
```

The plain command failed because GitHub attempted to read the retired Projects Classic field. The
read-only fallback below succeeded and returned issue #318 with its acceptance criteria, labels,
state, URL, and zero comments:

```text
gh issue view 318 --repo horang-labs/tessera \
  --json number,title,body,labels,state,url,comments
```

This child worktree initially had no installed dependencies. The first baseline test launch failed
before collection with `Cannot find module 'next/server'`. `npm ci` then installed 1,050 packages
from the existing lockfile in about 17 seconds without changing tracked files. The unchanged
baseline subsequently passed 16/16 tests.

TDD red:

```text
npx tsx --test --test-name-pattern \
  "Session Notification Push uses" tests/web-push-contract.test.ts
```

Result: 0 passed, 1 failed as intended; expected `{ TTL: 300, urgency: 'high' }`, actual
`undefined` (436 ms runner duration).

Focused green used the same command. Result: 1 passed, 0 failed (318 ms runner duration).

Final targeted Push dispatcher verification:

```text
node --import tsx --test --test-force-exit tests/web-push-contract.test.ts
```

Result: 17 tests, 17 passed, 0 failed, 0 skipped; Node test duration 607 ms, wall time 0.64
seconds, exit 0. This includes the exact TTL/urgency assertion plus the unchanged expired,
permanently rejected, and transient failure subscription behavior.

```text
npx tsc --noEmit
```

Result: exit 0, 2.14 seconds.

```text
npx eslint src/lib/push/web-push-dispatcher.ts tests/web-push-contract.test.ts
```

Result: exit 0 with no output, 1.32 seconds.

```text
git diff --check
```

Result: exit 0.

The full suite was deliberately not run, as required by the ticket/orchestrator instructions.

## Code review

`$code-review` was invoked with fixed point
`61db1ac97ec5a5666f09350db19b2a5a23efa6b0`, diff command
`git diff 61db1ac...HEAD`, and commit list command `git log 61db1ac..HEAD --oneline`. Its explicitly
authorized parallel, review-only agents were `/root/review_standards` and `/root/review_spec`.
Findings were restricted as requested to acceptance-criteria gaps and hard violations of
documented repository standards.

### Standards

No retained findings. The two-file change follows the existing injected-dispatcher and async test
patterns, remains focused, avoids broad refactoring, and adds no platform-sensitive behavior. No
hard violation of `AGENTS.md` or `CONTRIBUTING.md` was found.

### Spec

No retained findings. The reviewer confirmed that `{ TTL: 300, urgency: 'high' }` is supplied and
asserted at the dispatcher seam, existing permanent rejection/subscription cleanup behavior is
unchanged and covered, and no out-of-scope behavior or device-delivery claim was added.

Summary: Standards 0 findings (no worst issue); Spec 0 findings (no worst issue). No post-review
code change was required.

## What could not be verified

- No Android real-device delivery or notification-display verification was performed. That
  evidence remains owned by #309.
- No real Push service or FCM endpoint was contacted, so this work does not provide a service
  acceptance response or device receipt/display evidence. In particular, it makes no claim that
  HTTP 201 proves device display.
- No Electron instance, Electron E2E, browser UI, or cross-boundary runtime was launched because
  the ticket is a dispatcher-only change and explicitly forbids disturbing the user's instance.
- No full-suite result is claimed.

## Deliberately left out

- Native Android Firebase delivery or changes to Android/Chrome/Samsung scheduling, Doze,
  thermal, JobScheduler, notification-channel, or OEM background policy behavior.
- A device receipt or notification-display acknowledgement protocol.
- Service-worker, UI, subscription storage, VAPID identity, payload, or cleanup refactors.
- Changes beyond the requested urgency/TTL dispatcher contract and its focused regression test.
- Push, pull request creation, issue mutation, or Electron execution.

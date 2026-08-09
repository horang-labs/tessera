# Issue 305 implementation report

## Outcome

Implemented GitHub issue #305, “Bind Push Subscriptions to the Paired Device lifecycle,” on top
of the completed blocker branch `feature/0809-t303`
(`8ae2c6547e754e5d41e335544b333b0e547211b3`). The initial implementation commit is
`4ff7d12f50f198fa27ae47d8a603fe415f1f36c8`; the code-complete review-fix commit is
`5d7139a01506715bc3ffd52d06fbb01a110243db`. No inherited blocker commit was rewritten.

## What changed and why

- Moved Push subscriptions out of the paired-device registry into an owner-only, atomically
  written `push/device-subscriptions.json` store. Its persisted map is keyed by Paired Device ID,
  so registering again for one authenticated device replaces that entry instead of appending a
  duplicate.
- Added a paired-device lifecycle boundary shared by credential authentication, subscription
  reads/writes, device-list snapshots, and revocation. Subscription registration rechecks the
  device while holding that boundary, so a request authenticated before revocation cannot publish
  a subscription afterward.
- Made single-device revocation remove the subscription, revoke the credential, and synchronously
  disconnect active WebSockets under one externally observable lifecycle operation. Revoke-all
  applies the same ordering to every device. If registry persistence throws, the subscription
  snapshot is restored before the operation fails.
- Added `hasPushSubscription` to device-list responses and a read-only “Push enabled” status badge
  in Paired Device management. No per-device Push control was introduced.
- Made the dispatcher delete locally expired subscriptions without sending, and delete provider-
  rejected subscriptions only for permanent `404`/`410` responses. Other provider and network
  failures are logged without exposing capability URLs and leave the record available for retry.
- Kept capacity, comparison approval, last-seen, connected-state, list, single revoke, and
  revoke-all behavior on their existing seams. Tests cover replacement, status, lifecycle cleanup,
  expiry, transient failures, and the authenticated-request/revocation race.

## Skill and TDD execution

The GitHub issue was supplied directly as the ticket to `$implement`. The skill's `/tdd` seam ran
through these slices:

1. Separate device-keyed persistence and replacement: the first contract run failed because the
   new store module did not exist, then passed after owner-only atomic persistence and keyed
   replacement were implemented.
2. Device-list status and lifecycle cleanup: tests first observed missing
   `hasPushSubscription`, then exercised single-device/revoke-all cleanup. A deferred authenticated
   Push request reproduced the authorization race before lifecycle serialization made it green.
3. Remote Access UI: the existing device-list e2e first timed out waiting for Push status, then
   passed with the read-only badge and with the unsubscribed device retaining only its existing
   disconnect action.
4. Delivery cleanup policy: the dispatcher test was red before local expiry and permanent versus
   transient failure classification existed, then passed while confirming transient retention.
5. Review regression: the existing WebSocket revocation seam was extended to pair a real device,
   attach a real socket and subscription, invoke the public revocation operation, and assert all
   three forms of access disappear together.

Repository orientation used the required graphify workflow and targeted source reads rather than
inferring branches from the graph. The final `graphify update .` completed successfully with
10,134 nodes, 26,841 edges, and 432 communities.

## Commands and measured results

Issue read:

```text
gh issue view 305 --repo horang-labs/tessera
```

The default rendering path emitted GitHub's retired Projects Classic GraphQL warning instead of
the issue. The read-only structured fallback succeeded and supplied the authoritative title, body,
label, state, and all acceptance criteria:

```text
gh issue view 305 --repo horang-labs/tessera --json number,title,state,body,labels
```

Final targeted tests, run after applying review findings:

```text
node --import tsx --test --test-force-exit \
  tests/web-push-contract.test.ts \
  tests/web-push-service-worker.test.ts \
  tests/device-registry.test.ts \
  tests/request-gate.test.ts \
  tests/pairing-approval.test.ts \
  tests/ws-server-hardening.test.ts
```

Result: 55 tests, 55 passed, 0 failed, 0 skipped/cancelled, 2.202 seconds. This includes the
production WebSocket singleton revocation path, post-revocation credential rejection, subscription
replacement and cleanup, capacity/approval/list regressions, expiry, transient retention, and the
deferred request race.

```text
TESSERA_E2E_SCREENSHOT=/home/work/tmp/t305-push-device-status.png \
  node tests/remote-access-device-list.e2e.mjs
```

Result: exit 0. All eleven reported checks were true: device metadata, connected device,
single-device disconnect, revoke-all confirmation, empty state, capacity, pairing approval,
accessible decision buttons, keyboard approval, expired state, and list-error state. The same run
asserted Push status on subscribed devices and no added Push toggle on an unsubscribed device.
The captured screenshot SHA-256 is
`693bfca749b9448513fb7887b10afbf2ab24732122df2fafa8574bedd67583b1`.

```text
npx tsc --noEmit
```

Result: exit 0.

```text
npm run lint
```

Result: exit 0 with 0 errors and 3 pre-existing warnings outside this ticket:
`preview-markdown.tsx` (`no-img-element`), `use-virtual-message-list.ts` (React Compiler
incompatible library), and `spawn-cli-runtime.ts` (unused eslint-disable).

```text
git diff --check
```

Result: exit 0. No full suite was run, as required by the child-worktree wave instructions.

## Windows Electron / cross-boundary verification

After reading the cross-boundary and isolated-Electron notes, the reported Windows-server + WSL
CLI topology was exercised with the repository's `tessera-electron-dev` workflow:

```text
bash "$PWD/.codex/skills/tessera-electron-dev/scripts/build_and_launch.sh" \
  --repo "$PWD" --count 1 --session-id "codex-305-lifecycle-0809-2205"
```

Result: Next production compilation succeeded in 105 seconds, its TypeScript phase in 15.6
seconds, and all 50 routes plus Electron preparation and portable packaging completed. The Windows
portable artifact SHA-256 was
`d55a37e5b518a1acaa96bd3888f8a20e4803dc7520f54cdc11538032523f25c6`; the unpacked launch
executable SHA-256 was
`b98f70394a4152b135e7ee0be829d0ee11ca2144052cc75f18b9855578a7ca56`. The isolated instance
used Windows PID 17836, server `http://localhost:32125`, CDP `http://127.0.0.1:9338`, and its
own data root under
`C:\Users\work\AppData\Local\TesseraTestInstances\codex-305-lifecycle-0809-2205`.
CDP reported the packaged `/chat` document complete with title `Tessera`.

A Windows Node probe against that packaged server created and approved a paired device, registered
two subscriptions for it, read device status, opened an authenticated real WebSocket, invoked the
public device DELETE operation, and checked the on-disk separate store and the old credential:

```json
{
  "packagedServer": true,
  "replacementVisibleInSeparateStore": true,
  "deviceStatusBeforeRevoke": true,
  "revokedDevices": 1,
  "disconnectedConnections": 1,
  "revokedCredentialStatus": 401,
  "deviceCountAfterRevoke": 0,
  "subscriptionCountAfterRevoke": 0
}
```

The initial probe correctly returned `409 address-required` before the isolated machine advertised
an address; after configuring that isolated setting, the complete probe above passed.

Cleanup used `scripts/stop-electron-test-session.ps1` with
`-SessionId codex-305-lifecycle-0809-2205 -RemoveData`. It stopped only PID 17836, removed its
isolated data and manifest, and closed ports 32125/9338. The generated portable executable,
unpacked directory, and temporary smoke script were moved to the desktop trash and are
recoverable there. The installed Tessera app/server remained alive (PIDs 44248/33516, port 32123).
The production database hashes were identical before and after:

- `tessera-dev.db`: `e3271c7dc7a9ef4babfc82be8bb84e2c50ae0828f59509097c1e360fbea9c380`
- `tessera.db`: `8095eae016a1675fc896f2d95477865f6d7c00b8dff6221f1302847bad58a54c`

## Code review

`$code-review` was invoked exactly with fixed point `feature/0809-t303`, diff command
`git diff feature/0809-t303...HEAD`, and commit-list command
`git log feature/0809-t303..HEAD --oneline`. Its explicitly authorized review-only parallel agents
were `/root/review_305_standards` and `/root/review_305_spec`.

### Standards

No hard violation of `AGENTS.md`, `CONTRIBUTING.md`, or the linked domain standards was found. The
review also found no secret or sensitive capability URL logging. Baseline smells and judgement-only
suggestions were excluded under the requested hard-violation threshold.

### Spec

Two acceptance-criteria gaps were found:

- High: revocation originally serialized subscription mutation with credential mutation but reads
  and authentication did not share that boundary, exposing a possible partial state; a registry
  persistence failure after subscription deletion could also leave a partial result. Fixed by the
  shared lifecycle boundary and subscription rollback in commit `5d7139a`.
- Medium: the revocation regression asserted zero disconnected connections and therefore did not
  prove the active-WebSocket part of the operation. Fixed by extending the existing WebSocket seam
  to use the production singleton and assert one synchronous disconnect in commit `5d7139a`.

Summary: Standards 0 findings; Spec 2 actionable findings, both fixed (worst: externally observable
partial revocation state).

## What could not be verified

- The designated isolated headful Linux/WSL display was unavailable:
  `DISPLAY=:99 xdpyinfo` exited 1. Per policy, no user-visible WSLg fallback was used. The existing
  headless device-list e2e passed and its screenshot was inspected, but it is not claimed as
  headful evidence. The screenshot is retained at
  `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\t305-push-device-status.png`.
- No real third-party Push provider/browser endpoint was contacted. Permanent/transient provider
  classification and retention are covered with injected provider responses; the packaged runtime
  verified the actual Windows server, WSL-originated paired-device API, separate persistence,
  credential, and WebSocket boundaries.

## Deliberately left out

- No per-device Push toggle, per-kind setting, durable delivery queue, endpoint migration beyond
  keyed replacement, or provider-specific retry policy was added.
- No change was made to pairing capacity, comparison approval UX, last-seen semantics, or unrelated
  device-management behavior beyond surfacing subscription presence.
- No full-suite run, no modification or rewriting of blocker commits, no push, and no pull request.

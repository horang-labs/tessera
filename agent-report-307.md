# Issue 307 implementation report

## Outcome

Implemented GitHub issue #307, “Implement destructive Mobile Connection Removal,” from fixed
point `d1b3f56523a3522d75e53e3b86d8981c4d3aabca` (`feature/0809-wo`). The completed #301 and
#305 blocker commits were inherited and were not graded, rewritten, or otherwise modified.

Ready Remote Access settings now expose a destructive Mobile Connection removal action separately
from the reversible global Push toggle. The confirmation explains device disconnection, future
re-pairing, and notification setup. Successful removal returns immediately to Not configured and
disables pairing; failure keeps the dialog open with a safe retry state.

The Electron coordinator reloads persisted ownership, re-inspects the current Tailscale node and
Serve state, and removes only the exact owned HTTPS root with the original port and mount flags.
It never invokes `tailscale serve reset`. It verifies endpoint absence and the preservation of
unrelated Serve/Funnel/shared HTTPS resources before deleting ownership metadata. A local,
app-secret-only cleanup endpoint clears devices, pending/consumed pairing state, device Push
subscriptions, VAPID identity, and live device WebSockets under the paired-device lifecycle lock.
Push delivery now shares that lock, preventing an in-flight dispatch from notifying a removed
device or recreating the retired VAPID identity. A newly paired browser replaces a subscription
whose application-server key belongs to the old identity.

The implementation commit is `2fdbb574ed50428078f6f7a7797d869d1e8410fa`; review fixes are in
`aefcc47`.

## `$implement` invocation and `/tdd` seams

The GitHub issue body was supplied directly as the complete ticket to `$implement`; there was no
separate ADR or design document. The skill's `/tdd` seam ran through:

- **Coordinator/ownership:** RED tests required immediate node/Serve inspection, exact scoped
  `off`, already-absent success, unrelated resource preservation, fail-closed ambiguity, retained
  metadata on failure, and a fresh subsequent setup.
- **CLI adapter:** RED contract coverage required the precise
  `serve --bg --yes --https=<port> --set-path=/ off` arguments and prohibited global reset.
- **Trust lifecycle:** RED integration coverage required registry/pending/consumed state,
  subscriptions, VAPID identity, and an authenticated live WebSocket to disappear together.
- **Settings/browser:** the existing desktop E2E was extended to require destructive copy,
  retry-on-failure, Not configured success, disabled pairing, and an unchanged global Push toggle.
- **Review concurrency seams:** the first review-fix run was deliberately RED at 48/51: an
  in-flight Push dispatch did not block trust removal, VAPID deletion failure skipped WebSocket
  termination, and mutation of a shared HTTPS TCP resource escaped Serve verification. The same
  three files passed 51/51 after the lifecycle and resource-comparison fixes.

Repository orientation used `graphify query` only for specific graph vocabulary, followed by
`graphify explain` and source reads. After the final source changes, `graphify update .` completed
with 10,225 nodes, 27,019 edges, and 426 communities; generated graph files remain ignored.

## Commands and measured results

- `gh issue view 307 --repo horang-labs/tessera` was attempted first. GitHub CLI's retired
  Projects Classic field caused that rendering path to fail; `gh api
  repos/horang-labs/tessera/issues/307` succeeded and supplied the authoritative issue body.
- `npm ci` installed 1,050 packages and reported 46 audit findings: 2 low, 13 moderate, 28 high,
  and 3 critical. Dependency-audit remediation was outside this ticket.
- Final targeted command:

  ```text
  node --import tsx --test --test-force-exit tests/mobile-access-coordinator.test.ts tests/tailscale-cli-adapter.test.ts tests/electron-serve-only-contract.test.ts tests/electron-app-secret-header-contract.test.mjs tests/electron-mobile-lifecycle-contract.test.mjs tests/web-push-contract.test.ts tests/ws-server-hardening.test.ts tests/request-gate.test.ts tests/pairing-approval.test.ts
  ```

  Result: 100 tests, 100 passed, 0 failed/skipped/cancelled, 2,626.971 ms.
- `npx tsc --noEmit`: exit 0, no output.
- `npm run lint`: exit 0, 0 errors and 3 inherited warnings outside this ticket
  (`preview-markdown.tsx`, `use-virtual-message-list.ts`, `spawn-cli-runtime.ts`).
- `git diff --check`: exit 0, no output.
- `node --check tests/mobile-access-setup.e2e.mjs`: exit 0. The file is 152 lines.
- `DISPLAY=:99 xdpyinfo`: exit 1 because display 99 was unavailable. Per the ticket rule, the
  headful mocked browser E2E was not run and WSLg was not used.

No full suite was run, as required by the wave instructions.

## Packaged Windows Electron verification

The required cross-boundary and isolation notes and `tessera-electron-dev` skill governed the
Windows Electron run. Before launch, installed Tessera server port 32123 was owned by PID 15040;
an unrelated launcher-owned instance already occupied 32124 and was left untouched. Source DB
SHA-256 values were:

- `tessera-dev.db`: `a0f60eff5b506a90c99085457c93f6ea1824c25ac55fbfd4a95070bfe1073961`
- `tessera.db`: `8095eae016a1675fc896f2d95477865f6d7c00b8dff6221f1302847bad58a54c`

Build and launch command:

```text
bash "$PWD/.codex/skills/tessera-electron-dev/scripts/build_and_launch.sh" --repo "$PWD" --count 1 --session-id "codex-307-removal-0809-2340" --seed-data-dir "/home/work/.tessera"
```

The production Next build completed in about 2.1 minutes, its TypeScript phase in 22.6 seconds,
generated 51 routes, completed Electron compilation/runtime preparation (8,078 runtime files),
packaged Windows x64, and launched successfully without `TESSERA_DEV_PORT`. The unique portable
handoff was
`C:\Users\work\Downloads\Tessera-0.2.3-hotfix.1-feature-0809-t307-electron-dev-20260809-234809.exe`;
the matching unpacked `Tessera.exe`, rather than the portable wrapper, was launched. The isolated
Electron PID was 39516, packaged server port 32126, CDP port 9339, with data under
`C:\Users\work\AppData\Local\TesseraTestInstances\codex-307-removal-0809-2340\data`.

Windows Node/CDP confirmed a complete page titled `Tessera` at
`http://localhost:32126/chat`. A Windows PowerShell probe seeded only the isolated VAPID file and
sent an app-secret-authenticated `DELETE` to
`http://127.0.0.1:32126/api/mobile-access/local-state`; it returned `success=true`,
`revokedDevices=0`, `disconnectedConnections=0`, and the VAPID file no longer existed. The
packaged settings page then showed Not configured, enabled setup, one unchanged global Push
toggle, and no removal button (correct outside Ready). The visually inspected screenshot is
`\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-307-mobile-removal-settings.png`, SHA-256
`4d278ef9ba91555232a8b6b6423062d056aadf8aea676450b5624b90373e01df`.

Cleanup used `scripts/stop-electron-test-session.ps1 -SessionId
codex-307-removal-0809-2340 -RemoveData`; it stopped only PID 39516 and removed the isolated data
and manifest. Ports 32126/9339 closed. The portable artifact and unpacked directory were moved to
desktop trash. Installed PID 15040/port 32123 and both source DB hashes were unchanged.

## `$code-review`

The requested `$code-review` pinned `d1b3f56`, confirmed the non-empty
`git diff d1b3f56...HEAD`, and dispatched read-only Standards and Spec agents in parallel.

### Standards

The initial Standards pass found two hard process findings: the graph was stale, and the packaged
boundary evidence had not yet been recorded in the diff. `graphify update .` was run after both
source commits, and this report now records the isolated packaged topology, mutation, invariants,
and cleanup evidence.

### Spec

The initial Spec pass found four acceptance gaps. Three were applied:

- Push dispatch now holds the paired-device lifecycle until delivery settles, so removal cannot
  clear trust and then allow an old dispatch to recreate VAPID/send to the removed device.
- WebSockets disconnect immediately after registry trust is cleared, even if later VAPID deletion
  fails.
- Shared HTTPS TCP state participates in unrelated-resource comparison whenever another Serve
  path or Funnel uses the owned port.

The fourth noted that the browser E2E mocks the Electron removal call. That is accurate but not
safely fixable by changing the user's live Tailscale mapping; deterministic coordinator, adapter,
server lifecycle, real WebSocket, and UI tests cover the individual public boundaries, while the
packaged smoke covers the real Electron/server filesystem boundary. The unexercised live mapping
is explicitly recorded below.

## Not verified and deliberately left out

- The packaged run did not click Ready-state removal or mutate the user's global Tailscale Serve
  mapping. Doing so could interrupt the installed app. Exact `off`, already-absent, failure,
  unrelated Serve/Funnel, and fresh-setup behavior is covered deterministically by the targeted
  tests, not by a live tailnet E2E.
- The headful browser confirmation screenshot/test could not run because `DISPLAY=:99` was
  unavailable. No visual claim is made for the unobserved confirmation geometry.
- The full suite, dependency audit remediation, inherited lint warnings, global Serve reset,
  Funnel changes, pushing, and opening a PR were deliberately left out.
- Browser notification permission itself is controlled by the browser and cannot be revoked by
  Tessera. Removal deletes the VAPID identity and subscriptions; after fresh setup/re-pairing the
  Push flow requests permission and creates a subscription for the new VAPID key.

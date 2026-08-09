# Issue 308 verification report

## Outcome

Implemented and verified GitHub issue `horang-labs/tessera#308` from fixed point
`850c0fc` (`merge: issue 307 mobile connection removal`). The prerequisite implementations for
Push (#304), lifecycle (#306), and destructive removal (#307) were already merged at that point.

The ticket adds a fail-closed, test-only seam that lets one isolated packaged Windows Electron
instance execute a copied fake `tailscale.exe`. The executable is accepted only for a validated
Electron test instance and only from inside that instance root; normal launches ignore the test
override. The launcher copies and hashes both the fake executable and a test-only HTTPS CA into
the instance's private `tools` directory, records them in its ownership manifest, and restores the
calling PowerShell environment afterward.

A controlled Windows executable now proves real Windows command execution and scoped Serve
reconciliation without reading or mutating the user's global Tailscale state. Its initial model
contains unrelated background Serve, Funnel, foreground, and service resources. Setup adds only
the owned HTTPS root, removal turns off exactly that root, and the unrelated model compares equal
before and after.

The existing mobile browser fixtures were brought forward to the #307 prerequisite: pairing and
device management are available only while Mobile Connection is Ready. A single-use packaged
acceptance harness is included for the remaining Windows package boundary through an isolated
HTTPS proxy, including HTTP and WebSocket authentication from the advertised Serve origin. The
timeboxed runtime coverage reached a precise subset of that harness, recorded below.

## Safety and topology boundary

The user's installed Windows Tessera was treated as immutable throughout. No command stopped,
signalled, attached to, seeded from, or wrote to its process tree, database, ports, userData,
control files, logs, or Tailscale configuration.

Two leaked WSL development-server processes from earlier browser attempts were handled by exact
ownership checks only:

- PID `897563` had this worktree as its `/proc/<pid>/cwd` and owned test port `44159`; only that PID
  received `TERM`, and the listener closed.
- At the later checkpoint PID `966319` was already absent. Ports `35263` and `40361` had no
  listeners, so no signal was sent.

Windows stub directories used during deterministic development were removed after their output
was captured. No broad process-name or port-based kill was used.

The intended packaged topology is:

```text
isolated Windows Tessera.exe
  -> isolated packaged Windows server child (dedicated loopback port)
  -> copied instance-local fake tailscale.exe (real Windows processes)
  -> test-owned localhost HTTPS/WSS proxy (dedicated port 10443)
  -> authenticated packaged HTTP/WebSocket request gates
```

`TESSERA_DEV_PORT` is never set for the packaged run, so a WSL development server cannot be
mistaken for packaged Windows evidence. The run uses one unique unpacked app copy, a unique
launcher session/owner token, fresh empty data and Chromium userData, unique server/CDP ports,
instance-local tools/log/control paths, and no production seed.

## Deterministic implementation evidence

The Windows fake was built with:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File \
  scripts/build-fake-tailscale.ps1 -OutputPath <fresh-Windows-temp>\tailscale.exe

node.exe tests/windows-tailscale-stub.e2e.cjs \
  --executable=<fresh-Windows-temp>\tailscale.exe
```

Measured result: the final executable SHA-256 was
`cfe8e2acfca2c4b2b8b7117b1f015b89edb5d0ddfac489ca52d7b539b0cab603`. Six separate
invocations (PIDs `50760`, `47896`, `44132`, `10880`, `45404`, and `22464`) reported Windows in
`Environment.OSVersion`, recorded their exact executable/arguments, preserved unrelated
background Serve, Funnel, foreground and service state across configure/remove, issued no
`reset` or `funnel` command, and reported `liveTailscaleTouched: false`. Every Windows temp root
used while developing or finally verifying the stub was removed after capture.

The final safety review added a no-side-effect `--tessera-test-marker` handshake. The launcher
refuses any supplied executable that does not return
`tessera.issue-308.fake-tailscale.v1` before copying it or allowing any Serve command. A Windows
`-PrepareOnly` launcher run accepted the marked fake, copied the same SHA-256 below an isolated
root, created fresh empty data/userData, launched no process, and was then removed. This prevents
an accidental real `tailscale.exe` path from turning the controlled harness into a live mutation.
An unmarked Windows `node.exe` control was rejected with the explicit marker error before copy or
launch; its empty prepare-only root was removed immediately.

Focused unit/integration verification:

```text
node --import tsx --test --test-force-exit \
  tests/electron-test-instance.test.ts \
  tests/tailscale-cli-adapter.test.ts \
  tests/mobile-access-coordinator.test.ts \
  tests/serve-only-security.test.ts \
  tests/request-gate.test.ts \
  tests/ws-server-hardening.test.ts \
  tests/ws-session-access-guard.test.ts \
  tests/web-push-contract.test.ts \
  tests/web-push-service-worker.test.ts \
  tests/notification-store-dedup.test.ts \
  tests/session-notification-presentation.test.ts
# 112 tests, 112 passed, 0 failed

node --test <selected Electron lifecycle/quit/launcher contracts>
# 14 tests, 14 passed, 0 failed
```

Mobile-sized controlled browser evidence:

- `node tests/mobile-access-setup.e2e.mjs`: passed missing/configuring/authorization/ready states,
  external steps, pairing gating, removal failure/retry/success, unchanged global Push setting,
  and absence of manual firewall steps.
- `node tests/pair-page.e2e.mjs`: passed pairing completion, fragment-token removal, cookie/local
  approval, denial, rotation, retry, and error/expired states.
- `node tests/pwa-installation.e2e.mjs`: passed manifest/service-worker scope, optional and repeated
  install behavior, authenticated-cache exclusion, iOS guidance, and desktop escape.
- `node tests/web-push-notification.e2e.mjs`: passed permission prompt only after user action,
  denial without breaking the app, exactly one background notification, and click navigation to
  the session/prompt URL. A headed `DISPLAY=:99` attempt could not start because no X server was
  available; the successful run was headless and makes no visual geometry claim.
- `node tests/remote-access-device-list.e2e.mjs`: passed device metadata, connection state,
  individual revocation, disable-all, empty/capacity states, and pairing approval/keyboard/
  expiry/error behavior.

Static verification:

```text
npx tsc --noEmit
npm run electron:compile
npm run server:compile
npm run lint
git diff --check
```

TypeScript and both compilers passed with no diagnostics. The production prebuild also passed,
generated 51 routes, and prepared 8,078 Electron runtime files. Windows x64 unpacked packaging
completed with Electron 33.4.11. ESLint passed with zero errors and three
inherited warnings in `preview-markdown.tsx`, `use-virtual-message-list.ts`, and
`spawn-cli-runtime.ts`. `npm ci` installed 1,050 packages and reported 46 audit findings (2 low,
13 moderate, 28 high, 3 critical); no dependency or audit rewrite was made.

The repository-wide `*.test.ts` and `*.test.mjs` command ran 1,761 tests: 1,746 passed, 13 failed,
and 2 were skipped. All 13 failures are inherited source-text contract drift in files untouched by
#308 (`file-read-timeout-contract`, `model-default-selection-contract`,
`parent-worktree-authority`, `provider-usage-rail-contract`, `terminal-contract`, and
`workspace-file-drag-contract`). The #308 focused suite above is green.

## Guarded packaged Windows Electron evidence

The `tessera-electron-dev` workflow, its isolation contract, and the repository cross-boundary
notes governed the only Electron launch. The portable wrapper was not used. The production build
was emitted to a ticket-specific directory and copied to the unique unpacked directory:

```text
C:\Users\work\Downloads\Tessera-issue-308-acceptance-0810-a-unpacked\Tessera.exe
SHA-256 b6cb8c947f8ffc117ff21af25c79318ec949f8b63f22b2f22fcf88c47c35b25e
```

### Read-only pre-launch isolation audit

At `2026-08-09T16:01:08.1003208Z`, Windows PowerShell recorded:

- installed Electron main PID `41576`, `Responding=true`, executable
  `C:\Users\work\AppData\Local\Temp\3HgIafkDR2qvU4A8RaQKw7saRYO\Tessera.exe`;
- installed packaged server PID `47528`, parent `41576`, listener `32123`, and unauthenticated
  `/api/setup/status` response `401` (reachable and enforcing authentication);
- installed database `C:\Users\work\.tessera\tessera.db`, initial SHA-256
  `3f751af26ff08aedbbdb599b36d7440eb9f199ab5e2363e769b6dd13813fbd28`;
- live read-only `tailscale serve status --json` SHA-256
  `87c92b050a8446dc718d3539079f3981041425cdb21fe7f7eb3d1003773ddcc2`;
- ports `9458`, `32238`, and `10443` free;
- session manifest and instance root absent;
- the app copy existed at a distinct path; the fake executable and test CA existed only in the
  ticket-specific temp root with SHA-256 values
  `060325ec7c6aa71593bf3bd95aaa229f5c0fda28b714294339904df2ee2044e6` and
  `5f9a10ffe7f2e952acc3c062fd09830e535a83061ce6adfa0c5a202d53c1f15a`.

The launcher command was:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File \
  scripts/launch-electron-test-instances.ps1 \
  -Executable 'C:\Users\work\Downloads\Tessera-issue-308-acceptance-0810-a-unpacked\Tessera.exe' \
  -Count 1 -SessionId 'codex-308-acceptance-0810-a' \
  -TailscaleExecutable '<ticket-temp>\tailscale.exe' \
  -NodeExtraCaCert '<ticket-temp>\localhost-cert.pem' \
  -CdpBasePort 9458 -ServerBasePort 32238 -WslDistro Ubuntu-24.04
```

No `SeedDataDir` or `TESSERA_DEV_PORT` was supplied. The manifest recorded fresh, separate
`data` and `user-data`, `databaseSha256: null`, copied tool hashes, owner token
`ad27fc345ed9440eb32afcc416bec8c8`, Electron PID `44304`, CDP `9458`, and packaged server
`32238`. Windows `Get-NetTCPConnection` recorded the server listener owner as PID `44556`, proving
the tested backend listener was a Windows child rather than a WSL dev server.

### Minimum packaged checks and precise boundary

The first Windows Node harness invocation did not load because WSL path conversion doubled an
already-expanded UNC prefix; it created no proxy or second Electron. The decoded command was then
passed via PowerShell `-EncodedCommand` to avoid argument rewriting.

That first functional pass exposed a deterministic fake defect: the fake represented a shared
443 host by replacing rather than merging handlers, and production reconciliation correctly
failed closed with `Unrelated Tailscale Serve or Funnel configuration changed`. Its captured
invocation log proved real Windows fake processes (PIDs `27612`, `4292`, `4236`, `17996`, and
`42608`) and the exact `status --json`, `serve status --json`, and scoped
`serve --bg --yes --https=443 --set-path=/ http://127.0.0.1:32238` commands.

Per the safety timebox, the Electron process was neither rebuilt nor relaunched. Only the
instance-local fake was corrected so its unrelated 443 root was occupied and setup selected the
audited free port 10443; its isolated setup progress/state/log were reset. The manifest tool hash
was updated to the corrected executable hash
`0c1d4965a0809c19879006309c808d004de0724559c777e365856ad2f6cf3137`.
Before the one allowed retry, parent PID `41576` was still responding and PID `47528` still owned
32123.

The retry advanced past these assertions:

- setup returned `{ state: 'ready', origin: 'https://localhost:10443' }`;
- pairing produced an `https://localhost:10443/pair#t=...` link;
- an unauthenticated HTTPS request through the controlled Serve-origin proxy returned `401`.

The next assertion expected `GET /api/projects` with the app secret to return 200, but that route
does not support GET and returned 405. Therefore this packaged run does **not** claim authenticated
HTTP 200, either WSS result, or removal. The harness was corrected to probe GET-capable
`/api/settings` and passes syntax/lint review, but was not rerun because the user explicitly
forbade another retry or Electron launch. Authenticated HTTP/WSS, scoped removal, and preservation
remain green at the deterministic request-gate/adapter/coordinator/Windows-stub seams.

### Exact cleanup and installed-parent invariants

Cleanup ran immediately after the retry regardless of outcome:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File \
  scripts/stop-electron-test-session.ps1 \
  -SessionId codex-308-acceptance-0810-a -RemoveData
```

The ownership script stopped only PID `44304`, removed the instance data and manifest, and
reported success. Follow-up audits proved process count 0 for that PID/app path; ports `9458`,
`32238`, and `10443` closed; and the manifest, instance root, copied app, ticket temp root, logs,
screenshots, and build directories were absent. The installed main/server remained PIDs
`41576`/`47528`, main remained responsive, 32123 remained owned by `47528`, and HTTP continued to
return 401. The live Serve-status SHA-256 remained exactly
`87c92b050a8446dc718d3539079f3981041425cdb21fe7f7eb3d1003773ddcc2`.

The production DB hash did not remain stable: it changed from the pre-audit value to
`45ecd3a632d4b8ddaf8196e35cd92bf3be2c34511141b9fb76e590e12b531f04`, then again within seconds
to `abd212a4a2215b83fd9796c21167bd8a45df3387db2277f3bfa8c2bc343e9305` while the installed
parent remained active. The test manifest proves the isolated app used its separate fresh data
root and no seed, so it had no path to this database; nevertheless the requested byte-for-byte
production DB invariant cannot honestly be claimed because the running parent itself was writing
the file during the audit window. No further Electron run was attempted.

## Acceptance mapping

- Setup states, stable relaunch ownership, foreground suppression, background notification/click,
  revocation, tray hide, quit warning, and destructive removal are covered by the deterministic
  coordinator/contract/browser suite plus the already-merged #304/#306/#307 packaged evidence.
- The guarded run establishes isolated identity/state/ports, a Windows packaged backend,
  instance-local Windows fake execution, Ready/pairing over controlled HTTPS, unauthenticated
  Serve-origin rejection, and exact cleanup. The authenticated HTTP/WSS/removal continuation is
  deterministic evidence only because of the timeboxed 405 fixture error described above.
- No real/global Tailscale state is used as test input or mutated.

## Review

The user explicitly prohibited delegation and child agents for this implementation session, so
the `code-review` skill's parallel reviewer-agent mechanism could not be used. A local two-axis
review against fixed point `850c0fc` inspected the complete production/test/report diff.

- Standards: no hard documented-standard finding remains. Test-only overrides are fail-closed,
  normal launches ignore leaked override state, launcher inputs are copied below the instance
  root, no production seed/live Tailscale mutation occurs, cleanup remains manifest-owned, new
  executable E2Es are 86 and 173 lines, and `git diff --check` is clean.
- Spec: the implementation/tooling covers every deterministic seam requested. Two runtime
  evidence limitations remain explicit rather than overstated: the packaged retry stopped at the
  incorrect HTTP method before authenticated HTTP/WSS/removal, and the active production DB was
  not byte-stable. These are verification limitations, not hidden success claims.

## Remaining #309 real-device handoff

The following are deliberately not claims of #308 and remain for #309:

1. Pair a real phone over a real owned tailnet HTTPS origin and install the PWA.
2. With Tessera foregrounded on the phone, trigger each eligible Session Notification and verify
   in-app presentation with no OS banner.
3. Background/close the PWA, trigger the same kinds, verify one real provider-delivered OS
   notification, tap it, and verify navigation to the exact session/prompt.
4. Restart packaged Tessera and verify the existing phone remains paired without reconfiguration.
5. Revoke one phone, then remove Mobile Connection, and verify live sockets, subscriptions, Push,
   and later reconnect attempts fail; set up and pair again to verify a fresh VAPID identity.
6. Verify tray hide preserves access and notification delivery; verify the native quit warning,
   cancel, confirmed quit interruption, and recovery after relaunch.
7. Before and after, capture the real `tailscale serve status --json` and prove every unrelated
   Serve/Funnel/foreground/service entry is byte-for-byte or structurally unchanged.
8. Repeat the packaged controlled command with the corrected `/api/settings` probe to capture
   authenticated HTTP 200, WSS 1008/1000, scoped removal, and the final fake invocation log in one
   uninterrupted run. Use a quiescent installed database or an application-level snapshot marker
   if a byte-stable production DB invariant is required.

These steps require explicit authorization and a disposable or knowingly owned live Tailscale
configuration; they must not be attempted beside an immutable production parent under the safety
constraints of this ticket.

## Commits and publication

The implementation commit is
`ac1c691106fca366b9ba638cc55bd852eba7e195` (`test: verify packaged Windows mobile access
(#308)`). This report is committed immediately after it on `feature/0809-t308`. The branch is
pushed to the matching origin branch, and issue #308 receives a concise evidence/limitations
comment without being closed.

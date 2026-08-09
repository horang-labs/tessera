# Agent report — GitHub issue 298

## Outcome

Implemented the complete happy-path Mobile Connection Setup flow described by
`horang-labs/tessera#298`. The implementation commits are:

- `58c18b7` — `feat: complete mobile access setup (#298)`
- `64499b4` — `fix: harden mobile access ownership recovery`

The fixed point used for review was `272bd61`.

## What changed and why

- Added a public `MobileAccessCoordinator` status contract with `not-configured`,
  `configuring`, and `ready` states. The coordinator serializes setup, inspects the
  Tailscale node and existing Serve state, configures only a free or exactly Tessera-owned
  HTTPS 443 root, reinspects the mutation, checks Tessera through the HTTPS origin, publishes
  that origin to the existing pairing settings, and only then returns Ready.
- Added a real Tailscale CLI adapter. It parses `tailscale status --json` and
  `tailscale serve status --json`, and configures the root with:
  `tailscale serve --bg --yes --https=443 --set-path=/ http://127.0.0.1:<port>`.
  Windows executable discovery covers the standard Program Files and LocalAppData paths.
- Added atomic machine-local ownership storage for owner ID, node DNS name, HTTPS origin,
  port, mount, and last loopback target. POSIX uses directory `0700` and file `0600`.
  Windows now applies a protected DACL containing only the current OS account to the
  directory, temporary file, and final atomically renamed file.
- Wired narrow Electron IPC handlers through the preload bridge and the existing renderer.
  The Remote Access card shows all three states, disables Add Device until Ready, and uses
  the verified Serve origin for the existing fragment-secret pairing link. Setup errors
  explicitly preserve local desktop access.
- Retained the existing comparison-code approval and credential issuance flow unchanged.
  Added English, Korean, Japanese, and Chinese strings.
- Added fake-adapter/state-store coordinator tests, CLI parser/argument tests, and an 81-line
  renderer e2e contract. Review regressions cover pairing-origin recovery, exact persisted
  endpoint ownership, and Windows ACL application order.

The review-driven ownership fix is deliberately narrow: an existing Serve root is considered
owned only when its observed node/443/root/target exactly matches the persisted record. If an
external actor replaces that target, setup returns `serve-root-in-use` and does not mutate it.
Restored status republishes the pairing origin before Ready, so a prior publication failure
cannot enable Add Device with a stale or missing origin.

## Implementation skill and TDD seams

The ticket was supplied directly to `$implement`. Its exploration phase read issue 298 with
`gh`, used the repository graph through `$graphify`, and then read the concrete coordinator,
Electron, renderer, and pairing seams. The implementation phase delegated these seams to
`/tdd`:

1. Coordinator happy path with a fake Tailscale adapter and real isolated file store:
   initial red was `ERR_MODULE_NOT_FOUND`; implementation made it green.
2. Tailscale JSON parsing and exact Serve argv construction: initial red was
   `ERR_MODULE_NOT_FOUND`; implementation made it green.
3. Renderer-visible state/gating contract: authored test-first. Its required headful execution
   could not start because the designated isolated display `:99` was unavailable; no WSLg
   fallback was used.
4. Review regressions: the first run had 2 passing and 3 failing tests; after the recovery,
   ownership, and Windows ACL fixes, the same file passed 5/5.

## Verification commands and measured results

### Issue, graph, and dependencies

```text
gh issue view 298 --repo horang-labs/tessera
```

Read successfully and treated as the complete agreed specification.

```text
graphify query "mobile remote tailscale serve setup paired device origin health settings"
```

Oriented the work to the Remote Access renderer, pairing contract/device registry, and
Electron main-process seams.

```text
npm install
```

Completed; 1,042 packages added. npm reported 46 dependency-audit vulnerabilities. No audit
upgrade was attempted because it is outside issue 298.

### Required and targeted checks

```text
npx tsx --test tests/mobile-access-coordinator.test.ts tests/tailscale-cli-adapter.test.ts tests/pairing-approval.test.ts tests/electron-pairing-approval-contract.test.mjs
```

Exit 0; 15/15 tests passed after review fixes.

```text
node tests/remote-access-device-list.e2e.mjs
```

Exit 0. Verified device metadata, connected-device rendering, disconnect, disable-all,
capacity, comparison-code approval, accessibility decision control, keyboard approval,
expiry, and list-error behavior.

```text
npx tsx --test tests/request-gate.test.ts
```

All 29 assertions printed `ok`, but the existing runner kept an open handle and did not
terminate. An interrupt was sent after the completed TAP output, producing exit 130 in the
original PTY, but its process tree remained live and the command is not reported as passing.
Final handoff cleanup identified the exact ticket-owned tree by parent session, command, and
working directory, then stopped only PIDs `2809256`, `2809151`, `2809124`, `2809111`,
`2809110`, and `2809038` with `SIGTERM`. All six exited without escalation. Ports `32124` and
`9337` remained closed; no issue-298 test, server, browser, or Electron runtime remained.

```text
npx tsc --noEmit
npm run electron:compile
npm run lint
git diff --check
```

All exited 0. Lint had three pre-existing warnings: `preview-markdown.tsx` uses `<img>`,
`use-virtual-message-list.ts` uses an incompatible-library API for React Compiler, and
`spawn-cli-runtime.ts` has an unused eslint-disable directive. There were zero lint errors.

```text
graphify update .
```

Exit 0 after the final code changes: 9,974 nodes, 26,484 edges, and 425 communities.

The full suite was not run because the ticket explicitly prohibits it in this child worktree.

### Headful renderer attempt

```text
DISPLAY=:99 node tests/mobile-access-setup.e2e.mjs
```

The command failed before assertions because the isolated X display `:99` was unavailable.
It was not retried on a user-visible WSLg display. The exact spawned development-server PID
`2753217` was stopped (TERM, then KILL when it did not exit); no broad `pkill` was used.

### Isolated Windows Electron and real Tailscale topology

```text
bash "$PWD/.codex/skills/tessera-electron-dev/scripts/build_and_launch.sh" \
  --repo "$PWD" --count 1 --session-id "codex-0809t298"
```

The production Next build, TypeScript compilation, Electron compilation, and Windows portable
build succeeded. The isolated instance used Windows Electron PID `25836`, Windows server PID
`23860`, server port `32124`, CDP port `9337`, and its own test data directory. The portable
artifact SHA-256 was
`7496895b12e383d3cd1bcd11dfeda8f6931ea8077705d59cf9fadd7fcfa03e6b`; the unpacked Tessera
executable SHA-256 was
`d65d8e59dc082c51cca5ada8c88999a1958014eb1fa1a185e7156cd859814465`.

Real Windows Tailscale was version `1.98.4`, `BackendState` was `Running`, and node DNS was
`window.tail67973d.ts.net.`. `CertDomains` was `null`, so this node was not HTTPS-ready. The
real Serve state before and after setup was byte-for-byte equivalent: existing TCP 3100 and
HTTP 3127 entries remained, and no HTTPS 443 entry was created. This is the expected
fail-before-mutation behavior.

CDP observation of the packaged renderer measured:

- Add Device initially disabled: `true`
- observed status sequence: `Not configured`, `Configuring`
- Ready observed: `false`
- Add Device finally disabled: `true`
- local Settings remained interactive after failure: `true`

A screenshot was captured and visually inspected for the failure claim, then removed during
required isolated-test cleanup.

Cleanup used the repository stop script with only session `codex-0809t298`; it stopped PID
`25836`, removed the isolated data/manifest, and left ports `32124` and `9337` closed. The
user's normal Tessera remained on port `32123`. The source development database SHA-256 was
unchanged before and after:
`e3271c7dc7a9ef4babfc82be8bb84e2c50ae0828f59509097c1e360fbea9c380`.
The exact copied portable, unpacked test directory, screenshot, and CDP helper were removed;
these disposable test copies are not recoverable, and no user data was removed. Real
Tailscale Serve state remained unchanged.

### Post-review Windows ACL check

After `npm run electron:compile`, Windows Node v24.15.0 loaded the compiled state-store module,
saved a state record under the real Windows temp filesystem, and queried both ACLs with
PowerShell. The measured output was:

```json
{"statePath":"C:\\Users\\work\\AppData\\Local\\Temp\\tessera-mobile-access-acl-mXxmFx\\machine\\mobile-access.json","results":[{"protected":true,"currentOnly":true},{"protected":true,"currentOnly":true}]}
```

The exact temporary Windows directory was deleted in the script's `finally` block.

## Code review invocation and findings

`$code-review` was invoked exactly as the requested two-agent parallel review, with fixed
point `272bd61` and the issue as the only spec. The agents were restricted to acceptance-
criteria gaps and hard documented-standard violations. They were re-run after fixes.

### Standards

One hard verification violation remains. The deterministic renderer e2e uses a mocked
Electron/Tailscale contract. The isolated packaged run proves the exact Windows Electron →
Windows server topology, the real non-HTTPS-ready failure behavior, non-mutation, and desktop
survival; the Windows Node run proves current-user-only ACLs. However, because real Tailscale
reported `CertDomains: null`, it was impossible to create HTTPS Serve 443, reach Ready, or
probe the endpoint from a real consumer. Therefore the exact-environment successful happy
path required by `.claude/notes/cross-boundary-testing.md` remains unverified. No other hard
repository-standard violation was found. The review also requested cleanup of the temporary
screenshot, which was completed.

### Spec

The first pass found three gaps:

1. a saved endpoint could later become Ready without retrying failed pairing-origin
   publication;
2. ownership did not compare the observed Serve target to the persisted loopback target;
3. POSIX modes did not provide owner-only storage on Windows.

All three were fixed in `64499b4`. The second Spec pass verified the fixes and reported no
remaining issue 298 acceptance-criteria gaps. Its focused coordinator/store contract suite
passed 5/5 and the review diff was clean.

Review summary: Standards — one externally blocked successful-topology verification gap;
Spec — no remaining acceptance-criteria gaps.

## What could not be verified

- The real HTTPS-ready success path, HTTPS health request through Tailscale Serve, and a real
  mobile-consumer pairing probe. The available Windows node has no Tailscale certificate
  domain. Enabling tailnet HTTPS requires external administrative state and was not attempted.
- The new headful renderer e2e on isolated WSL display `:99`, because that display was absent.
- Clean natural termination of `tests/request-gate.test.ts`, despite all 29 assertions passing.

## Deliberately left out

- The full test suite, per the child-worktree verification rule.
- Enabling Tailscale HTTPS or changing tailnet administrative configuration.
- Tailscale Serve teardown/cleanup UX and later lifecycle work not requested by issue 298.
- Removal or redesign of the existing manual remote-access controls.
- Changes to the established comparison-code approval/credential issuance protocol.
- npm audit dependency upgrades and the three unrelated lint warnings.
- Push and pull-request creation.

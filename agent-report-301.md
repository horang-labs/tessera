# Issue 301 implementation report

## Scope and outcome

Implemented `horang-labs/tessera#301` from fixed point
`5c00c0f3c054ae38de9e91a659fdc6b94cb39304` (`feature/0809-t300`). Commits inherited
from that completed blocker branch were not modified or rewritten.

The packaged Electron backend now has one listener, fixed to `127.0.0.1`. Tailscale Serve
is the only remote transport: the completed, Tessera-owned `mobile-access.json` record is the
source of the HTTPS origin used by the request Origin allowlist and pairing links. Pairing and
registered-device credentials remain the HTTP and WebSocket authorization gate.

Removed the retired direct-access system end to end:

- external-interface listener selection, retry/synchronization, and shutdown branches;
- advertised-address normalization and machine-level `remote-access.json` persistence;
- network-address candidate discovery and renderer IPC;
- Windows firewall capability detection, configuration, IPC, and UI;
- manual address/direct-access guidance in all four locales;
- tests for the retired listener and firewall behavior.

Remote Access settings now show only Tailscale Serve setup/status, local pairing approval,
pairing issuance after Serve reaches Ready, and registered-device management. The initial
implementation commit is `89e439fcf9de15a05855e08938ed828a9bb4358a`. Review-driven
coverage/runtime cleanup is in `4b8a052c4a6dfbb11f1a9bda03cc1b519b680e71`; the final
fail-closed E2E ownership guard is `c30b2c392d5de832c63b328314e2b7b24d7c37b6`.

## Skill invocation and TDD seams

The provider `$implement` skill was loaded and GitHub issue 301 was supplied as its complete
ticket; no separate ADR or design document was assumed. Graphify was used first for repository
orientation, then updated after the source changes. Because the behavior crosses the Windows
Electron / WSL CLI boundary, the repository `tessera-electron-dev` skill and the required
cross-boundary/isolation notes governed packaged verification.

The following pre-agreed public seams ran through `/tdd`:

- **Electron listener seam:** the contract initially found the packaged server's direct
  interface listener branch; green fixes the sole host to `127.0.0.1` and removes that branch.
- **Settings/API/UI seam:** the security contract initially found `machineSettings`, a direct
  advertised address, address candidates, and firewall UI/IPC; green removes those surfaces
  and proves an obsolete input cannot create `remote-access.json`.
- **Serve origin/auth seam:** the contract initially observed a direct IP in the allowlist and
  pairing link, and an unauthenticated Serve WebSocket failed for the wrong reason
  (`origin-not-allowed`); green derives the owned HTTPS origin from `mobile-access.json` and
  rejects unauthenticated Serve HTTP/WS as `unauthorized`.

The first meaningful RED run had four failing assertions, one at each acceptance boundary:
settings still returned `machineSettings`, the allowlist contained a direct IP instead of the
owned Serve origin, pairing links used that direct IP, and the Serve WebSocket decision was
`origin-not-allowed` rather than `unauthorized`. The same security file later passed 4/4.

## Verification commands and measured results

- `gh issue view 301 --repo horang-labs/tessera` was attempted first and failed because the
  GitHub CLI query includes the removed Projects Classic field. `gh api
  repos/horang-labs/tessera/issues/301` then succeeded and supplied the authoritative issue.
- `npm ci` installed 1,042 packages and reported 46 audit findings: 2 low, 13 moderate,
  28 high, and 3 critical. No audit rewrite was performed.
- `npx tsx --test --test-force-exit tests/serve-only-security.test.ts
  tests/mobile-access-coordinator.test.ts tests/electron-serve-only-contract.test.ts
  tests/tailscale-cli-adapter.test.ts tests/electron-remote-access-status.test.ts
  tests/pairing-approval.test.ts tests/electron-pairing-approval-contract.test.mjs
  tests/electron-app-secret-header-contract.test.mjs` passed: 51 tests, 51 passed, 0 failed,
  duration 1,429.205 ms.
- `npx tsx --test --test-force-exit tests/request-gate.test.ts` passed: 26 tests, 26 passed,
  0 failed, duration 644.272 ms.
- `DISPLAY=:99 node tests/mobile-access-setup.e2e.mjs` passed and measured all setup states,
  Add-device gating until Ready, Serve-origin pairing, and absence of manual-address and
  firewall controls. Its screenshot was visually inspected at
  `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-301-serve-only-settings.png`.
- `DISPLAY=:99 node tests/pair-page.e2e.mjs` passed the pairing, approval/denial, token
  rotation, cookie, retry, and failure-state checks.
- `DISPLAY=:99 node tests/remote-access-device-list.e2e.mjs` passed device metadata,
  connected state, disconnect/disable-all, capacity, local approval, keyboard, expiry, and
  error-state checks.
- The modified visual E2E is 122 lines. The new Windows security E2E is 180 lines; the two
  new targeted contract files are 116 and 43 lines, respectively.
- `npx tsc --noEmit` passed with exit code 0 and no output.
- `npm run electron:compile` passed with exit code 0.
- `npm run lint` passed with 0 errors and 3 pre-existing warnings in
  `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`.
- `git diff --check` passed with no output.
- `graphify update .` completed with 10,007 nodes, 26,513 edges, and 369 communities. It
  warned that saved community labels could be refreshed; generated graph outputs are ignored
  and were not committed.

No full suite was run, as required by the ticket's wave verification rules.

## Packaged Windows Electron / WSL boundary verification

Inherited Tessera environment variables were inspected before starting any runtime. The
installed app baseline was listener owner PID 33516 on port 32123, including its inherited
old direct `100.103.66.17:32123` listener. The source database SHA-256 was
`e3271c7dc7a9ef4babfc82be8bb84e2c50ae0828f59509097c1e360fbea9c380`.

The final source was built and launched with:

```text
bash "$PWD/.codex/skills/tessera-electron-dev/scripts/build_and_launch.sh" --repo "$PWD" --count 1 --session-id "codex-issue-301-final" --seed-data-dir "/home/work/.tessera" --output-name "Tessera-Issue-301-Serve-Only" --output-dir-name "Tessera-Issue-301-Serve-Only-win32-x64"
```

Measured result:

- the production Next build, its TypeScript phase, Electron compile, runtime preparation,
  Windows x64 packaging, and isolated launch all succeeded;
- portable artifact `C:\Users\work\Downloads\Tessera-Issue-301-Serve-Only.exe` has SHA-256
  `692d3be941932f5b26e7d9dfcd2acbed54d8aaeac7f250f0d290af3840ff4861`;
- unpacked `Tessera.exe` has SHA-256
  `9513b2dc99d1f801e03fc300eb69bf44829c61b7ab0a5352a9bed28805d85090`;
- isolated Electron PID 47308 used packaged server port 32124 and CDP port 9337 under
  `C:\Users\work\AppData\Local\TesseraTestInstances\codex-issue-301-final`;
- Windows Node/CDP confirmed one complete page titled `Tessera` at
  `http://localhost:32124/chat`; the renderer screenshot at
  `C:\Users\work\Downloads\Tessera-Issue-301-Serve-Only.png` was visually inspected and has
  SHA-256 `17c2a60cc8052c28abc03557c03fecb5b5f491782dcfb7af7ae7f8f223ab1d69`;
- `Get-NetTCPConnection` measured exactly one backend socket,
  `127.0.0.1:32124` owned by packaged server PID 51840;
- a Windows TCP probe reached `127.0.0.1:32124`, while probes to `192.168.100.1`,
  `192.168.78.1`, `172.17.240.1`, LAN address `192.168.0.101`, and Tailscale address
  `100.103.66.17` all returned `Connected=false`;
- after adding a completed owned-origin record only to the isolated data, an unauthenticated
  Windows request with Host `desktop.tailnet.ts.net` and Origin
  `https://desktop.tailnet.ts.net` returned HTTP 401; a Windows WebSocket probe opened the
  upgrade and was closed with policy code 1008 and reason `Unauthorized`.

The review-driven committed security E2E then automated those measurements. It was run through
Windows Node against isolated session `codex-issue-301-ownership`:

```text
powershell.exe -NoProfile -Command "& 'C:\Program Files\nodejs\node.exe' '$PWD/tests/electron-serve-only-security.e2e.cjs' '$PWD' '--cdp=http://127.0.0.1:9337' '--session-id=codex-issue-301-ownership' '--serve-origin=https://desktop.tailnet.ts.net'"
```

Before writing its isolated owned-origin fixture, the E2E validated the launcher session
manifest, CDP owner PID, owner token, executable, command line, server port, and derived test
data directory, and refuses port 32123. It passed with packaged server PID 41256 listening
only on `127.0.0.1:32124`, the same five non-loopback addresses unreachable, HTTP 401, and WS
1008 `Unauthorized`. Cleanup stopped only isolated PID 8024 with `-RemoveData`.

Cleanup used the ownership-manifest stop script without a broad process kill:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$PWD/scripts/stop-electron-test-session.ps1")" -SessionId 'codex-issue-301-final'
```

It stopped only isolated PID 47308. Port 32124 closed; installed-app port owner PID 33516 and
its 32123 listeners remained, and the source database SHA-256 was unchanged.

## Code review

The requested `$code-review` skill pinned fixed point `5c00c0f`, confirmed a non-empty
three-dot diff, and dispatched its Standards and Spec agents in parallel with read-only
restrictions.

### Standards

The first pass reported no findings. After the review-driven security E2E was added, the
second pass found one hard isolation violation: the script accepted an arbitrary data
directory and could overwrite `mobile-access.json` without proving it belonged to the
connected launcher-owned instance. The final fix derives the directory only from a validated
session manifest and checks process/CDP ownership before mutation. A final parallel re-review
against `c30b2c3` reported no remaining Standards findings.

### Spec

The first pass found three acceptance gaps:

- the packaged pairing/device/WS E2E still assumed a direct origin on the backend port;
- committed tests did not automate the real Windows packaged socket/interface boundary;
- obsolete direct-listener switch `TESSERA_ELECTRON_PACKAGED` remained in the child env.

The pairing E2E now requires an owned Serve HTTPS origin without backend-port coupling, the
180-line Windows security E2E covers the packaged boundary and auth gates, and the obsolete
switch is removed with contract coverage. The next Spec pass reported no remaining findings;
a final parallel re-review against the fail-closed safety commit `c30b2c3` also reported no
remaining acceptance-criteria findings.

Final summary: Standards 0 findings; Spec 0 findings.

## Not verified and deliberately left out

- The packaged security probe exercised the real Windows backend listener and authorization
  gate using the owned Serve Host/Origin, but did not traverse or change the user's global
  Tailscale Serve mapping. Mutating that global mapping could interrupt the running app. The
  Serve coordinator/adapter path is covered deterministically by the 51-test targeted run.
- The retired direct listener has no migration, fallback, or compatibility transport. An
  obsolete `machineSettings` input is ignored and cannot recreate its file or listener.
- The full suite, dependency-audit remediation, unrelated lint warnings, pushing, opening a
  PR, Funnel changes, foreign Serve resources, and login-startup behavior were deliberately
  left out.
- The unique Downloads artifact/unpacked directory and the first stopped-instance data were
  retained for reproducibility. Review verification sessions were removed with `-RemoveData`;
  their duplicate Downloads artifacts were moved to trash and remain recoverable. No user
  production data was changed.

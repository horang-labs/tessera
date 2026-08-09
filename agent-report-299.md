# Issue 299 implementation report

## Scope and outcome

Implemented GitHub issue `horang-labs/tessera#299` from fixed point
`2c82c533ce6830749c6b0ba9f2cd5929f36d19ad` (`feature/0809-t298`). Commits that
predate that fixed point were not reviewed or rewritten.

The Mobile Connection setup now:

- distinguishes missing Tailscale, sign-in, machine authorization, stopped/starting,
  HTTPS authorization, configuring, ownership conflict, retryable failure, and ready;
- opens install/sign-in/HTTPS-consent pages through Electron and polls resumable states;
- persists setup progress and a deterministic port choice across settings close/reopen;
- uses 443 only when its HTTPS root can be owned safely, otherwise selects the first free
  port from `10443, 11443, 12443, 13443` and revalidates a retained port before mutation;
- parses Serve state strictly, preserves unrelated Serve/Funnel resources, and uses only the
  scoped `tailscale serve --bg --yes --https=<port> --set-path=/ <target>` mutation;
- verifies fresh node/Serve state and HTTPS health before publishing the pairing origin;
- bounds CLI execution, uses `detached: false`, and force-terminates authorization waits,
  oversized-output commands, and timeout-resistant children;
- presents localized, state-specific next-step guidance in English, Korean, Japanese, and
  Chinese.

The initial implementation commit is
`4243f9cc381dfd72108e7b947c7ee078b419a979`. Review-driven fixes are in
`d1b2da0fc609443624c10b51f620d63269750af0`.

## Skill invocation and TDD seams

The provider `$implement` skill was loaded and issue 299 was supplied as its ticket; the
GitHub issue was treated as the entire agreed specification. Repository orientation used
the existing Graphify graph first, and `graphify update .` was run after code changes.

The following seams ran through `/tdd` red-green cycles:

- adapter classification and strict node/Serve JSON parsing;
- coordinator state transitions, sign-in and consent resumption, retained progress, safe
  port fallback/revalidation, unrelated Serve/Funnel preservation, and post-mutation health;
- bounded command execution, including a child that deliberately ignores `SIGTERM`;
- retryable coordinator behavior after an injected command timeout.

Measured red evidence included three failures before the second review fixes: missing typed
unavailability reason, a retained foreign-owned 10443 being configured and reported ready,
and the SIGTERM-resistant timeout taking about 2.31 seconds instead of staying below one
second. The malformed `Running`/`CertDomains` regression also failed first with “Missing
expected exception.” All became green after their corresponding implementation changes.

## Verification commands and results

- `gh issue view 299 --repo horang-labs/tessera` was attempted first as requested; GitHub's
  deprecated classic-project field caused a GraphQL error. The read-only fallback
  `gh issue view 299 --repo horang-labs/tessera --json number,title,body,url,labels`
  succeeded and supplied the ticket body and acceptance criteria.
- `npx tsx --test tests/mobile-access-coordinator.test.ts tests/tailscale-cli-adapter.test.ts tests/electron-direct-tailscale-access.test.ts tests/electron-remote-access-status.test.ts tests/pairing-approval.test.ts tests/electron-pairing-approval-contract.test.mjs`
  passed: 54 tests, 54 passed, 0 failed, duration 1.416 seconds on the final run.
- `npx tsc --noEmit` passed with exit code 0 and no output.
- `npm run electron:compile` passed with exit code 0.
- `npm run lint` passed with 0 errors and 3 pre-existing warnings in
  `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`.
- `git diff --check` passed.
- `wc -l tests/mobile-access-setup.e2e.mjs` reported 114 lines.
- `graphify update .` completed after the final source change: 10,018 nodes, 26,583 edges,
  and 385 communities. Graphify warned that community labels could be refreshed; generated
  graph outputs are ignored and were not committed.
- `npm install` completed with 1,042 packages and reported 46 audit findings (2 low,
  13 moderate, 28 high, 3 critical). No broad audit fix was run because it is outside this
  ticket.

No full test suite was run, per the wave instruction.

## Packaged Windows Electron / WSL boundary verification

Before starting a server, inherited Tessera variables were inspected. Because this behavior
crosses Electron, Windows, the Tailscale CLI, and the network boundary, the repository's
`tessera-electron-dev` workflow was used rather than a WSL development server.

Final-source build and launch command:

```text
bash "$PWD/.codex/skills/tessera-electron-dev/scripts/build_and_launch.sh" --repo "$PWD" --count 1 --session-id "codex-0809t299-final"
```

Measured result:

- production Next build, TypeScript, Electron compile, runtime preparation, and Windows x64
  portable packaging all succeeded;
- portable path was
  `C:\Users\work\Downloads\Tessera-0.2.3-hotfix.1-feature-0809-t299-electron-dev-20260809-205633.exe`,
  SHA-256 `0521c6d0bbb5d047101e8654c676dde37142b7a6293db487d97f4be0b0f20639`;
- unpacked `Tessera.exe` SHA-256 was
  `392e8440920a2d63ce866dd58ab0c33afd6b7e5d2292b5ace41d9f56bc440ec0`;
- isolated Electron PID was 31632, packaged server port 32125, and CDP port 9338. Port 9337
  was already owned by another isolated ticket instance and was deliberately left alone;
- the launcher's copied database hash was
  `e3271c7dc7a9ef4babfc82be8bb84e2c50ae0828f59509097c1e360fbea9c380`.

The required CDP inspector command:

```text
powershell.exe -NoProfile -Command "& 'C:\Program Files\nodejs\node.exe' '$PWD/.codex/skills/tessera-electron-dev/scripts/inspect_electron_cdp.cjs' '$PWD' '--cdp' 'http://127.0.0.1:9338'"
```

confirmed one complete page titled `Tessera` at `http://localhost:32125/chat`. Windows
Tailscale 1.98.4 reported `BackendState: Running`, DNS name
`window.tail67973d.ts.net.`, and `CertDomains: null`.

The real setup flow was exercised through the packaged Electron renderer. It moved from
“Not configured” through “Configuring” to “Authorization required”, displayed “Open
authorization”, “Retry”, and “Approve Tailscale HTTPS in your browser. Tessera will continue
automatically.” The isolated persisted state was:

```json
{
  "schemaVersion": 1,
  "owner": "tessera.mobile-access",
  "phase": "setup",
  "loopbackPort": 32125,
  "selectedServePort": 443,
  "nodeDnsName": "window.tail67973d.ts.net"
}
```

Closing settings and reopening Remote access recovered the same actionable authorization
state without starting setup again. A 2100x1350 screenshot was captured and visually
inspected at `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\issue-299-final-authorization.png`;
SHA-256 is
`895eadbc5d9655da2209c3cb6d75a2a44c829a577b5f87660a6401d25f464b53`.

The exact Windows `tailscale serve status --json` output contained the pre-existing TCP 3100
forward and HTTP/Web 3127 root proxy. Hashing that command's output before and after setup
produced the same SHA-256 both times:
`9785a5863cf4d9c9c53d26b2368eb98489b376e973aea9f12ca00ddb99c9dc88`.
Therefore this authorization attempt did not alter those unrelated resources.

The isolated runtime was stopped only through its ownership manifest:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$PWD/scripts/stop-electron-test-session.ps1")" -SessionId 'codex-0809t299-final' -RemoveData
```

It stopped only PID 31632 and removed the isolated data and manifest. After cleanup, ports
32125 and 9338 were no longer listening; the original Tessera server remained PID 33516 on
32123. The source DB hash before and after was unchanged at
`e3271c7dc7a9ef4babfc82be8bb84e2c50ae0828f59509097c1e360fbea9c380`.
Generated portable/unpacked/release/runtime artifacts were moved to trash and remain
recoverable there.

## Code review

The `$code-review` skill was loaded and its two requested parallel agents reviewed the full
diff from fixed commit `2c82c533ce6830749c6b0ba9f2cd5929f36d19ad`. Findings were deliberately restricted to
acceptance-criteria gaps and hard documented-standard violations.

- Standards initially required durable evidence for the real Windows Electron/WSL topology;
  the packaged verification above supplies it. Final Standards result: **No findings**.
- Spec review found and drove fixes for foreign TCP ownership on 443, state-specific UI help,
  coordinator timeout resumption, retained-port revalidation, a soft-only timeout kill,
  machine-authorization guidance, and malformed `Running` node status. Each was addressed
  with a regression test. Final Spec result: **No findings**.

## Not verified and deliberately left out

- `DISPLAY=:99` was unavailable
  (`\\wsl.localhost\Ubuntu-24.04\tmp\.X11-unix\X99` was not a socket), so the mocked
  headful WSL browser e2e was not run and no WSLg fallback was used.
- Real Tailscale HTTPS consent was not approved because it would change the user's external
  tailnet state. Consequently, real-tailnet success and HTTPS health were not exercised;
  deterministic coordinator tests cover consent completion, fresh inspection, health, and
  publication.
- Tessera does not install Tailscale automatically, invoke Funnel, perform a global Serve
  reset, or repair foreign-owned endpoints. These were intentionally left outside the
  implementation.
- The full suite, dependency audit remediation, unrelated lint warnings, pushing, and opening
  a PR were deliberately left out.

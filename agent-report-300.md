# Issue 300 implementation report

## Scope and outcome

Implemented `horang-labs/tessera#300` from fixed point
`dbf9a5e88e12c07c0fe355d82a6c1d08ac8afe72` (`feature/0809-t299`). Commits before
that fixed point were not graded or rewritten.

Completed Mobile Connection ownership is now reconciled on each Electron launch after the
local server is ready and before the app window can offer pairing. Reconciliation:

- leaves an already-current owned endpoint and persisted settings untouched;
- preserves the public origin and Serve port while repairing only the owned backend target;
- recreates a missing mapping only when the persisted endpoint remains free;
- refuses unrecognized target or endpoint ownership without choosing another origin;
- reports configured missing, stopped, or signed-out Tailscale as Temporarily unavailable
  while allowing the desktop window to open;
- reports node/tailnet DNS changes as an origin conflict that requires Mobile Connection
  removal and fresh setup, without changing the persisted ownership record;
- verifies fresh node/Serve state, unrelated Serve/Funnel resources, HTTPS health, and the
  retained endpoint around repairs;
- gives localized origin-change guidance in English, Korean, Japanese, and Chinese.

No operating-system login-startup behavior was added.

The initial implementation commit is
`d1aaefcd87ee77bd2b7ffaa8ba70af5f90857cfd`. Review-driven fixes are in the final
implementation commit `02c397e8705d82b1f8ee8f44da6fd999a83a57f9`.

## Skill invocation and TDD seams

The provider `$implement` skill was loaded and GitHub issue 300 was supplied as its ticket;
the issue was treated as the complete agreed specification. Repository orientation used the
existing Graphify graph before source reads. `frontend-react-best-practices` kept the new UI
copy selection as render-derived state without a new effect or state layer. The
`tessera-electron-dev` and `playwright-cli` guidance supplied the isolated Windows packaging,
CDP, screenshot, and cleanup procedure.

The issue pre-agreed the public `MobileAccessCoordinator` seam. These `/tdd` red-green slices
ran there:

- no-op launch inspection initially failed because `reconcileOnLaunch` did not exist;
- changed loopback target initially returned Ownership conflict instead of repairing;
- absent mapping initially returned Ownership conflict instead of recreating;
- completed missing/signed-out Tailscale initially returned setup states rather than
  Temporarily unavailable;
- changed node/tailnet initially returned a generic conflict without removal/fresh-setup
  guidance;
- the first review's no-mutation regression failed because the no-op call trace still
  contained `publish:<origin>`; removing launch-time settings publication made it green.

Ownership loss was added as a green characterization of the fail-closed behavior. A delayed
`inspectServe` coordinator regression proves launch reconciliation cannot finish until Serve
inspection is ready, paired with the Electron lifecycle ordering contract.

## Verification commands and measured results

- `gh issue view 300 --repo horang-labs/tessera` was attempted first. GitHub's deprecated
  Projects Classic field caused a GraphQL error. The fallback
  `gh issue view 300 --repo horang-labs/tessera --json number,title,body,state,labels,assignees,url`
  succeeded and supplied the issue specification.
- `graphify query "MobileAccessCoordinator serve origin tailscale" --budget 2200` located the
  coordinator, adapter, Electron lifecycle, and existing coordinator tests before source
  inspection.
- `npx tsx --test tests/mobile-access-coordinator.test.ts tests/electron-app-secret-header-contract.test.mjs`
  passed on the final run: 21 tests, 21 passed, 0 failed, duration 220.152 ms.
- `npx tsc --noEmit` passed with exit code 0 and no output.
- `npm run lint` passed with 0 errors and 3 pre-existing warnings in
  `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`.
- `git diff --check` passed with no output.
- `npm ci` installed 1,042 packages and reported 46 audit findings: 2 low, 13 moderate,
  28 high, and 3 critical. No audit rewrite was performed.
- `graphify update .` completed after the final source changes: 10,031 nodes, 26,613 edges,
  and 382 communities. It warned that community labels could be refreshed; generated graph
  outputs are ignored and were not committed.

No full suite was run, as required by the ticket's wave verification rules.

## Packaged Windows Electron / WSL boundary verification

Inherited Tessera variables were inspected before starting a runtime. The final-source build
and first isolated launch used:

```text
bash "$PWD/.codex/skills/tessera-electron-dev/scripts/build_and_launch.sh" --repo "$PWD" --count 1 --session-id "codex-issue-300-final" --seed-data-dir "/home/work/.tessera" --output-name "Tessera-issue-300-final.exe" --output-dir-name "Tessera-issue-300-final-unpacked"
```

Measured result:

- production Next build, TypeScript validation, Electron compile, runtime preparation, and
  Windows x64 portable packaging all succeeded;
- portable SHA-256 was
  `1bd7100ce5f91008b41825a7fcad6b03afc26801ebd9d6b372b846fb801571c7`;
- unpacked `Tessera.exe` SHA-256 was
  `26412ff300d236459f0fe872a7a861295ae4fa0c20fd961f59b270e74c030174`;
- isolated Electron PID 36988 used packaged server port 32124 and CDP port 9337;
- Windows Node/CDP confirmed one complete page titled `Tessera` at
  `http://localhost:32124/chat`;
- the copied database initially matched the source database SHA-256
  `e3271c7dc7a9ef4babfc82be8bb84e2c50ae0828f59509097c1e360fbea9c380`.

For a safe real-packaged origin-change repro, the first isolated process was stopped through
its ownership manifest without removing the isolated data. A completed ownership record with
the deliberately stale DNS `retired-node.old-tailnet.ts.net` was added only to that isolated
data. The same final artifact was relaunched through the wrapper as PID 45988 on ports
32124/9337. Because the persisted DNS differed from the running node, this path did not inspect
or configure Serve.

A Windows Node CDP check opened Settings → Remote access and confirmed:

- status `Ownership conflict`;
- guidance `The Tailscale node or tailnet domain changed. Remove the existing mobile
  connection, then set it up again.`;
- `Add device` remained disabled;
- the renderer remained at `http://localhost:32124/chat`, title `Tessera`.

A 2100x1350 screenshot was captured and visually inspected at
`\\wsl.localhost\Ubuntu-24.04\home\work\tmp\issue-300-origin-change.png`; SHA-256 was
`496fb3c3cf988ea652036a5066f9234961044d8455d464177a3155dc538eae51`.

Final cleanup used:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$PWD/scripts/stop-electron-test-session.ps1")" -SessionId 'codex-issue-300-final' -RemoveData
```

It stopped only isolated PID 45988 and removed the manifest/data. Ports 32124 and 9337 closed;
the installed Tessera remained PID 33516 on port 32123. The source DB SHA-256 remained
`e3271c7dc7a9ef4babfc82be8bb84e2c50ae0828f59509097c1e360fbea9c380`.
The unique Downloads portable/unpacked copies and screenshot were moved to trash and remain
recoverable there.

## Code review

The requested `$code-review` skill pinned `feature/0809-t299`, confirmed a non-empty
three-dot diff, and dispatched its Standards and Spec agents in parallel with read-only
restrictions.

Initial reports, kept as separate axes:

- **Standards:** two hard evidence gaps: packaged cross-boundary/delayed-readiness evidence,
  and visual evidence for the new origin-change UI.
- **Spec:** one partial requirement: the no-op reconciliation still called
  `publishPairingOrigin`, causing a settings write despite “launch performs no mutation.”

The no-op publication was removed through a failing-then-passing coordinator test; the
delayed readiness test and packaged/CDP/UI evidence above address the Standards gaps. Both
agents then re-reviewed `git diff feature/0809-t299...HEAD` in parallel. Final results:

## Standards

No findings.

## Spec

No findings.

Final summary: Standards 0 findings; Spec 0 findings.

## Not verified and deliberately left out

- `DISPLAY=:99` was unavailable (`/tmp/.X11-unix/X99` was not a socket), so the headful WSL
  browser e2e was stopped and no user-visible WSLg fallback was used.
- A real owned Serve backend was not changed or recreated because doing so could mutate the
  user's tailnet. No-op/repair/recreation/ownership-loss/unavailability/origin-change behavior
  is covered deterministically through the coordinator seam; the packaged smoke covers the
  real Windows Electron → packaged server → Windows Tailscale inspection topology.
- Missing, stopped, and signed-out Tailscale were simulated at the adapter boundary rather
  than changing the user's installed Tailscale state.
- Credential/subscription migration and Mobile Connection Removal itself were not added;
  this ticket only detects the origin change, preserves ownership data, disables pairing, and
  explains the required next step.
- The full suite, dependency audit remediation, unrelated lint warnings, pushing, opening a
  PR, OS login startup, alternate public origins, Funnel changes, and foreign endpoint repair
  were deliberately left out.

# Agent report — issue #345

## Scope

Implemented the optional `tessera-cli` provider-skill experience from issue #345 on the fixed
integration baseline `16f3f27`, while reusing the Provider Integration policy and ownership
boundary delivered by #343 and #344.

- Added the authenticated provider-skill GUI API and a shared browser client.
- Added Settings cards for Claude Code, Codex, and OpenCode with independent status, consent,
  install, update, remove, ownership, conflict, and Agent Environment presentation.
- Added a non-blocking first-provider-Session onboarding offer. Deferring or dismissing the offer
  does not delay or block Session startup.
- Kept Codex's lifecycle hook required and provider discovery skills optional.
- Moved GUI action/onboarding decisions into Provider Integration instead of deriving ownership,
  conflict, or consent policy in the renderer.
- Bound every consent-changing GUI action to the Agent Environment shown when the user consented;
  a settings race fails with `PROVIDER_SKILL_ENVIRONMENT_CHANGED` before resolving or mutating a
  provider home.
- Isolated status failures to the owning provider so one unavailable provider does not hide its
  siblings.
- Treat externally modified or externally deleted Tessera-owned skills as conflicts and stop
  automatic management without changing unrelated provider/environment state.
- Added English, Korean, Japanese, and Chinese UI strings.

Concrete install command syntax and any broader recovery mechanism left TBD by #338 remain out of
scope. The UI invokes only the existing shared Provider Integration operations.

## Product commits

- `033bf99` — `feat: add provider skill onboarding and controls (#345)`
- `bfbdbbb` — `fix: harden provider skill policy boundaries (#345)`
- `88d08be` — `fix: stop skill management on external deletion (#345)`
- `570d90c` — `fix: keep provider skill ids client safe (#345)`

This report is committed separately from the product changes as requested.

## Test and build evidence

### Focused automated validation

Final command covered Provider Integration, lifecycle/route/UI policy, provider launch, CLI skill
management, onboarding, authenticated GUI route/settings UI, and Session activation contracts:

```text
tests 97
pass 97
fail 0
skipped 0
```

Notable behavioral coverage includes:

- first-start notification is non-blocking and is suppressed for failed or already-started paths;
- each provider and each `native | wsl` environment has an independent offer/consent state;
- the onboarding action retains the environment captured by its prompt;
- stale-environment consent is rejected before provider-home resolution;
- a provider-home inspection failure returns only that provider as unavailable;
- user-owned, externally modified, and externally deleted artifacts stop automatic management;
- newly detected providers remain absent until their own explicit consent/install;
- install/update/remove preserve unselected providers and the other Agent Environment;
- Settings renders optional status, scoped conflict guidance, and independent provider cards.

### Static/build gates

All final gates passed:

- `git diff --check`
- `npx tsc --noEmit`
- `npm run lint`
- `npm run server:compile`
- `npm run electron:compile`
- `npm run build` (Next production build, 48/48 static pages)
- `npm run electron:build:win` through the isolated Electron test wrapper
- `graphify update .` after the final code changes: 11,134 nodes / 29,103 edges / 420 communities

`graphify update .` emitted the existing extractor warning that `bin/provider-skill-ids.json`
produced zero AST nodes; the graph otherwise rebuilt successfully.

An intermediate Windows build correctly caught a server-only module leaking into the client
bundle through a runtime import. Commit `570d90c` extracted the provider ID manifest/guard into a
client-safe module; the subsequent production and packaged Windows builds passed.

### GUI and real-topology evidence

An isolated development server on port 31345 was used for visual GUI verification. The Settings
surface showed three independent provider cards, refreshed from Native to WSL after the Agent
Environment changed, preserved the required Codex hook/optional skill distinction, and had no
horizontal overflow at a 700 px viewport. No provider mutation action was invoked.

The final packaged topology was then built and launched as isolated session
`codex-345-final-0812-1358`:

- portable SHA-256:
  `a5870796a76642f754e3d705c7b716c62c1cb6121aea1f0a7fa1f787734207d6`
- actual renderer user agent: Windows 10 x64, Electron 33.4.11;
- renderer URL: `http://localhost:32124/chat`, title `Tessera`;
- the instance used its packaged Windows server child on port 32124 (no `TESSERA_DEV_PORT`);
- the authenticated final-build status request resolved `agentEnvironment: wsl` and returned all
  three providers independently:
  - Claude Code: detected, absent, no consent, install/onboarding allowed;
  - Codex: detected, user-owned conflict, no mutation/onboarding allowed;
  - OpenCode: detected, absent, no consent, install/onboarding allowed.

This exercised the Windows Electron parent + Windows packaged backend reading the provider state
owned by WSL. It intentionally did not start a provider CLI or mutate a real provider home because
the acceptance behavior under test is optional discovery-skill policy/UI, and clicking install or
remove would alter user-global provider state.

Cleanup used only the launcher's ownership manifest. It stopped test PID 53952, removed the test
data/manifest and the exact copied portable/unpacked artifacts, and verified:

- original Electron PID 47576 remained alive;
- original server PID 23324 still owned port 32123;
- test PID and port 32124 were absent;
- test root and copied Downloads artifacts were absent;
- source DB SHA-256 remained
  `8095eae016a1675fc896f2d95477865f6d7c00b8dff6221f1302847bad58a54c`.

## Code review

The `$code-review` workflow ran Standards and Spec reviewers in parallel against fixed point
`16f3f27`.

Initial actionable findings and resolutions:

- stale onboarding actions could target a newly selected Agent Environment — fixed by carrying
  and validating `expectedAgentEnvironment` end to end;
- GUI duplicated Provider Integration ownership/consent policy — fixed by returning explicit
  action/onboarding policy from the boundary;
- one status exception hid all providers — fixed with per-provider unavailable state;
- resume/terminal paths could offer before a successful first start — fixed with the shared
  `notifyProviderSessionStarted` seam and success/first-start gating;
- settings and onboarding duplicated HTTP handling — fixed with one shared client;
- externally deleted Tessera-owned content could be recreated automatically — fixed by reporting
  a Tessera-owned conflict and leaving it absent;
- supported-provider checks were duplicated and briefly pulled a server module into the client —
  fixed with one manifest-derived, client-safe type guard;
- an obsolete direct-offer export was removed.

Final reviews at `570d90c`:

- Standards: clean; no hard violations or actionable judgment-call smells.
- Spec: clean; no missing/partial criteria, incorrect behavior, or scope creep.

## Full-suite baseline failures

The final repository-wide test run completed with:

```text
tests 2023
pass 2003
fail 18
skipped 2
```

All issue-345 focused tests passed. The following unchanged baseline contract failures remain
unrelated to this ticket:

1. `active workspace session resolves workspace special tabs to their source session`
2. `codex home probe keeps the login shell (reads $CODEX_HOME from rc)`
3. `deferred session creation stays pre-start until the provider starts`
4. `every user-facing New Tab command reuses an existing pristine empty tab`
5. `migrated checkout consumers cannot reintroduce direct child-first SQL`
6. `the narrow project rail scrolls without reserving visible scrollbar space`
7. `single-panel terminal sessions omit only the redundant session header`
8. `resume, delete, archive, restore, and worktree cleanup hold atomic handoff exclusion`
9. `server filesystem reads resolve WSL POSIX paths before calling node fs`
10. `terminal panels without a bound session do not inherit stale active session cwd`
11. `terminal panels preserve the source session context used to create them`
12. `terminal panels can be pulled into a new tab from a multi-panel layout`
13. `codex overlay placement and hook style follow the terminal runtime`
14. `OpenCode WSL sessions prepare a guest-native shared overlay`
15. `the bar offers exactly the five decided keys, in the decided order`
16. `each bar key sends the byte sequence a keyboard would`
17. `workspace file drags carry both panel and composer payloads`
18. `workspace folder rows expose the Electron open path context menu`

No GitHub issue/PR state was changed, nothing was pushed or merged, and no other worktree was
modified.

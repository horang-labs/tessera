# Agent report — issue #346

Issue: **Remove all Tessera-Owned Artifacts with Tessera**

Fixed integration baseline: `16f3f274c6bd5ada1adc48bbacc38fa012ec45bf`

## Product commits

- `930bc96` — `feat: clean up known provider artifacts (#346)`
- `0d9fd90` — `fix: resolve provider cleanup review findings (#346)`
- `34395f1` — `fix: preserve cleanup discovery uncertainty (#346)`

## Delivered scope

- Extended the shared Provider Integration boundary with application-removal cleanup and a
  structured `complete`, per-artifact outcome, problem, and recovery result.
- Added provider-owned lifecycle cleanup to the existing lifecycle contract. Cleanup discovers
  lifecycle implementations through the provider registry instead of naming Codex in the shared
  coordinator, and one provider discovery/cleanup failure does not prevent valid targets from
  being cleaned.
- Recorded every Authoritative Provider Home where Tessera installed a provider skill, separately
  for native and WSL Agent Environments, while preserving the existing user-global consent model.
- Removed only artifacts whose current content still verifies as Tessera-owned. User-created,
  externally modified, malformed, and ownership-conflicted hooks or skills are preserved and
  reported as conflicts.
- Preserved non-Tessera hook groups, provider authentication, configuration, history, and all
  other provider-owned state.
- Kept native and WSL cleanup routed through the owning environment and failed closed when that
  boundary could not be re-entered; there is no opposite-environment fallback.
- Made cleanup retryable and honest: failed/conflicted artifacts and unreadable discovery state
  produce `complete: false` with recovery guidance. Pre-home-ledger skill state retains a durable
  `unknownEarlierHomes` marker through later install/update/maintenance so an unknowable earlier
  installation can never be converted into false success.
- Exposed cleanup at the Provider Integration seam required by the future application-removal
  workflow. No new GUI, CLI syntax, force/ownership mechanism, or uninstaller behavior was added,
  because #338 explicitly leaves those concrete mechanics TBD.

## Test coverage

The cleanup regression suite covers:

- complete cleanup across native and WSL lifecycle/skill homes;
- partial failure followed by successful retry;
- strict owning-environment routing with no fallback;
- externally modified and user-owned artifact preservation;
- unreadable discovery state;
- earlier provider homes after a home switch;
- independent cleanup when one artifact family/provider fails; and
- legacy ledger migration through update while earlier-home uncertainty remains durable.

Final focused command:

```text
node --import tsx --test \
  tests/provider-launch-module.test.ts tests/tessera-control-skill.test.ts \
  tests/codex-wsl-overlay.test.ts tests/opencode-wsl-overlay.test.ts \
  tests/provider-skill-management.test.ts tests/provider-skill-cli.test.ts \
  tests/codex-provider-integration.test.ts tests/control-cli-bridge.test.ts \
  tests/control-runtime-host.test.ts tests/provider-integration-cleanup.test.ts \
  tests/provider-integration.test.ts tests/provider-integration-lifecycle.test.ts \
  tests/provider-lifecycle-hook-integration.test.ts
```

Result: **92 passed, 0 failed**.

## Static, compile, and build verification

- `npx tsc --noEmit` — passed.
- Changed-file ESLint for the two production files and cleanup test — passed with no findings.
- `npm run lint` — 0 errors and 3 unrelated existing warnings (`preview-markdown.tsx` image,
  `use-virtual-message-list.ts` incompatible library, and an unused disable in
  `spawn-cli-runtime.ts`).
- `npm run server:compile` — passed after the final product commit.
- `npm run electron:compile` — passed after the final product commit.
- `NODE_ENV=production npm run build` — passed after the final product commit; 47 static/dynamic
  application pages generated.
- `git diff --check 16f3f27...HEAD` — passed for the product commits.
- `graphify update .` — passed after final code changes: 11,111 nodes, 28,981 edges, 438
  communities. The existing `provider-skill-ids.json` zero-node warning remains.

## Repository-wide tests and unrelated baseline failures

The full repository command was run repeatedly:

```text
npx tsx --test --test-reporter=tap tests/*.test.ts tests/*.test.tsx tests/*.test.mjs
```

The stable result was 2,016 tests: 1,996 passed, 18 failed, and 2 skipped. After the new cleanup
regression, the final full run contained 2,017 tests and additionally hit a transient concurrent
`a huge diff is capped before it reaches the prompt` failure, for 1,996 passed, 19 failed, and 2
skipped; that test passed immediately in isolation (1/1).

The 18 stable failures predate and do not exercise #346 files. They are stale/baseline contract
assertions for active-workspace special tabs, the Codex home probe shell shape, deferred Session
creation, pristine New Tab reuse, checkout SQL source shape, narrow project rail styling,
single-panel terminal headers, terminal handoff exclusion, WSL filesystem source shape, unbound
terminal cwd, terminal source-session context, terminal panel-to-tab movement, Codex/OpenCode
overlay source contracts, terminal input-bar key count/bytes, workspace drag payload shape, and
workspace folder context-menu source shape. These are the same unrelated failure family recorded
by the preceding #343 integration report; no failing assertion imports or calls the cleanup code.

## Isolated packaged Windows + WSL evidence

Used the repository's `tessera-electron-dev` isolation workflow with
`TESSERA_DEV_PORT` unset and session `codex-346-0812-1329`.

- Built a Windows portable artifact and matching unpacked application. Portable SHA-256:
  `ffbc72687e0479b737248c333b0c5f9b046400a4d850a700c318bd5949bfca0a`;
  launched unpacked `Tessera.exe` SHA-256:
  `73a2444c776d1f5080e8ef6b0f6ed754ffef46c00ead1427142502550fbb12b3`.
- The isolated Electron renderer was reached through Windows CDP at `127.0.0.1:9337` and loaded
  `http://localhost:32124/chat` with title `Tessera` and `readyState=complete`.
- The packaged backend reported `serverHostInfo.platform=win32`, `arch=x64`, while settings
  reported `agentEnvironment=wsl`. This proves Windows Electron -> packaged Windows backend,
  rather than a Windows shell attached to a WSL development server.
- Backend diagnostics crossed into WSL and resolved/executed Claude Code `2.1.222`, Codex
  `0.146.0`, and OpenCode `1.18.16`. Codex correctly failed closed before spawn because the
  isolated profile had no consented lifecycle hook; it did not fall back to a Windows-native
  provider home.
- The installed Tessera server remained PID `23324` listening on port `32123` while the test used
  port `32124`.
- Source development database SHA-256 remained
  `fabdf9c2e088193b3aa64bf64c5cda1e1559f1ee5279c7a0958550ed78017b31` before and after.
- The test process was stopped only through its ownership manifest. Test data and manifest were
  removed, and copied Downloads artifacts plus local packaging outputs were moved to trash.

This packaged run proves the required Windows-backend-to-WSL-CLI production topology. The
deterministic cleanup suite proves deletion, preservation, conflict, partial failure, retry, and
legacy behavior without mutating the user's real provider homes.

## Code review

`code-review` ran Standards and Spec reviews in parallel against fixed point `16f3f27`.

Initial review findings and resolutions:

- Replaced direct Codex construction/identity in the shared coordinator with provider-registry
  lifecycle discovery.
- Made legacy pre-home-ledger state report earlier installations as unverifiable.
- Hardened provider discovery so missing/throwing lifecycle integrations fail closed per provider
  without skipping other targets.
- Replaced recovery selection by human-message parsing with structured discovery problem codes.
- Preserved legacy earlier-home uncertainty across later update/maintenance and added a regression.
- Confirmed the removal workflow requirement is satisfied at the Provider Integration boundary
  without inventing #338's explicitly TBD UI, command syntax, or removal mechanics.

Final repeated reviews: **Standards CLEAN; Spec CLEAN**. The final Spec review classified every
#346 acceptance criterion as implemented and found no scope creep.

## Remaining risks

- Application UI/CLI/uninstaller invocation syntax and concrete recovery mechanics remain TBD by
  #338 and are intentionally not designed in this ticket.
- Legacy ledgers created before provider homes were recorded cannot reveal the actual earlier path.
  Cleanup therefore preserves data and reports incomplete until a human inspects prior homes; it
  never guesses ownership or reports success.

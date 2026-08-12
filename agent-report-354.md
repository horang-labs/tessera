# Agent report — GitHub issue #354

Date: 2026-08-12 KST
Branch: `feature/0812-t354`
Fixed point: `b1b7e50299d441d1e9b68f23ebf98443be496f2d`
Implementation commit: `be466581bd009f347da5feeda406ef6d87277b60`

## What changed and why

`tests/helpers/phone-app-server.mjs` now constructs the isolated server environment from
an explicit platform allowlist instead of copying `process.env`. It also:

- removes provider overlay and Tessera control-bridge entries from `PATH` with
  case-insensitive, separator-neutral comparisons;
- uses `WSLENV` with absent authority variables to clear Windows-side Codex, Claude Code,
  OpenCode, Tessera, runtime descriptor, control bridge, and credential namespaces when a
  WSL-hosted server invokes a Windows process;
- gives the fixture its own `HOME`, `USERPROFILE`, temporary directories, data directory,
  port, runtime flags, and authentication state while leaving XDG variables absent so they
  cannot be forwarded as invalid cross-boundary paths;
- owns cleanup from the first allocated directory, and makes cleanup idempotent;
- stops the exact Unix process group, escalating from `SIGTERM` to `SIGKILL`, or the exact
  Windows process tree through `taskkill /pid <pid> /t /f`, and verifies exit;
- removes only the two paths allocated by the fixture;
- wraps every initialization error with the phase, owned origin/PID, and a bounded 8,000
  character server-log tail after caller values and credential patterns are redacted.

`tests/phone-app-server-lifecycle.test.mjs` adds public-boundary coverage for the hostile
environment, evidence redaction, and forced failures after server readiness, settings save,
Project registration, and Session creation. Each failure assertion proves that the exact
child PID is gone, the listener refuses connections, and both owned roots are absent.

## `$implement` and `/tdd`

The issue was supplied directly to `$implement` and the complete implementation loop was
run from this worktree. `/tdd` was used at both pre-agreed seams:

1. **Hostile-environment sanitization:** public seam
   `buildPhoneAppServerEnvironment(callerEnvironment, fixtureEnvironment)`. The first test
   failed because the export did not exist. Subsequent red cycles proved WSL interop clearing,
   future provider/credential namespace coverage, PATH overlay removal, host path delimiter
   use, and case-insensitive containment before each minimal implementation.
2. **Every-initialization-failure cleanup:** public seam
   `startPhoneAppServer({ name, failInitializationAt })`. The first test failed with the
   original settings HTTP 500 and leaked its exact child and roots; those test-owned resources
   were identified and removed before continuing. Vertical slices then covered startup,
   settings, Project, and Session failures. Review moved injection points after each phase's
   work so the assertions cover already-created state.

The failure-evidence redaction behavior was also developed red-to-green through the exported
sanitizer used by the public helper. No required seam was excluded from TDD.

## Reproduction and verification

Before starting any server, `env | rg -i 'tessera|__CFBundleIdentifier'` showed this caller's
real Tessera-managed authority, including `CODEX_HOME`, `TESSERA_CODEX_HOME`,
`TESSERA_CLI_COMMAND`, Project/Worktree/Session IDs, pane token, and hook port.

### Pre-fix characterization

- `node tests/mobile-rail-and-toast-placement.e2e.mjs`
  - Initial attempt: exit 1 before allocation because dependencies were absent.
  - After `npm install`: exit 1 in 4.46s at settings initialization with HTTP 500.
  - Evidence: process group `2496095`, two Node listeners, and
    `/home/work/tmp/tessera-rail-toast-placement-data-n3WONq` plus
    `/home/work/tmp/tessera-rail-toast-placement-fixture-JGYbvr` remained.
  - Cleanup: only process group `2496095` and those two exact paths were stopped/removed;
    follow-up PID/path checks passed.

### Focused fixture

- `node --test tests/phone-app-server-lifecycle.test.mjs`
  - Final result: 7 passed, 0 failed in 16.97s.
- `for run_index in 1 2 3; do node --test tests/phone-app-server-lifecycle.test.mjs || exit; done`
  - Final post-review results: three consecutive 7/7 passes in 17.03s, 17.35s, and 19.33s.
- Residue probe:
  `find /home/work/tmp -maxdepth 1 -type d \( -name 'tessera-rail-toast-placement-*' -o -name 'tessera-phone-server-*' \) -print`
  plus an exact `server.ts` process listing.
  - Result: no owned path and no fixture server process remained.

### Ticket runtime

- `node tests/mobile-rail-and-toast-placement.e2e.mjs`
  - Pre-fix: settings HTTP 500 as above.
  - Post-fix passes (three separate runs, including the final post-review run):
    `ok — project rail fills 32px and phone toast ends at 80px above composer at 709px`.
  - One intermediate repeated run initialized and cleaned correctly but timed out after 15s
    waiting for the injected toast. The immediately following and final runs passed; no owned
    residue remained after the timeout. No toast/UI code was changed because it is outside #354.

### Required checks

- `npm run test:unit`
  - Exit 0: 1,756 tests, 1,754 passed, 2 skipped, 0 failed, 40.00s.
- `npm run test:contracts`
  - Exit 1: 376 tests, 374 passed, 2 failed. Both failures were in the unrelated
    `electron-test-launcher-contract.test.mjs` Windows harness because pre-existing ownership
    roots `~/.tessera/test-instances/env-contract*` (created at 18:58, before this ticket's
    contract run) belonged to other owner tokens. They were inspected and deliberately not
    deleted.
- `npx tsx --test $(rg --files tests -g '*.test.mjs' | rg -v '^tests/electron-test-launcher-contract\\.test\\.mjs$')`
  - Exit 0: all remaining 365 contract tests passed in 15.60s.
- `npx tsc --noEmit`
  - Exit 0, no output. Re-run after review fixes also exited 0.
- `npm run lint`
  - Exit 0 with 0 errors and 3 pre-existing warnings in
    `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`.
    Re-run after review fixes had the same result.
- `git diff --check b1b7e50..HEAD`
  - Exit 0 against the final ticket HEAD after the report correction.
- `graphify update .`
  - Exit 0 after the final code changes: 11,353 nodes, 30,150 edges, 445 communities.
  - Existing warning: `provider-skill-ids.json` produced zero graph nodes.

The full suite was not run, per the ticket's child-worktree verification rule.

## `$code-review` invocation and findings

The fixed point was pinned and verified with:

```text
git rev-parse b1b7e50
git diff b1b7e50...HEAD
git log b1b7e50..HEAD --oneline
```

The diff was non-empty. Issue #354 was the Spec source. `AGENTS.md`, `CONTRIBUTING.md`,
`.claude/notes/dev-server.md`, and `.claude/notes/cross-boundary-testing.md` were the Standards
sources. `$code-review` spawned its Standards and Spec reviewers in parallel with read-only,
no-further-agent restrictions.

### Standards

The Standards reviewer reported 4 findings:

1. **Hard:** `WSLENV` included fixture-defined XDG values, which could forward invalid host-side
   paths instead of clearing them across the bridge.
2. **Hard:** path containment was case-sensitive and the test used a literal POSIX delimiter,
   violating cross-platform path expectations.
3. **Hard:** Windows cleanup could return after the root child exited without killing its tree,
   and the local test did not prove the Windows branch.
4. **Judgment call — Duplicated Code:** the sensitive-environment-name predicate appeared in
   both isolation and evidence-redaction logic.

All implementation findings were applied: XDG fixture overrides were removed while their
Windows-side names remain scrubbed, path checks became separator-neutral/case-insensitive and
the test uses `path.delimiter`, Windows cleanup always targets the live tree and verifies exit,
and the sensitive-name predicate is shared. Exact Windows execution remains an explicit
verification limitation below.

### Spec

The Spec reviewer reported 2 findings:

1. **High:** Windows teardown could leave descendants alive (overlaps Standards finding 3).
2. **Medium:** settings/Project/Session injected failures occurred before their operations, so
   the test did not prove cleanup after those phases had created state.

Both were applied. Windows cleanup targets the exact tree, and every injected phase failure now
occurs after its phase succeeds.

Review summary: Standards 4 findings (worst: cross-boundary XDG forwarding / Windows process
tree cleanup); Spec 2 findings (worst: Windows descendants could survive). No scope creep was
reported.

## What could not be verified

- The Windows-specific `taskkill /t` branch was not executed in this Linux/WSL child worktree.
  The implementation was corrected from the parallel review, but only the Unix process-group
  topology received live PID/listener assertions here.
- The two unrelated Windows Electron launcher contract cases could not run because their
  pre-existing fail-closed ownership roots had different tokens. All other contract tests pass.
- No headful browser verification was needed. The requested mobile E2E is headless by default;
  therefore `DISPLAY=:99` was not used.
- No packaged Electron app was launched because #354 concerns the WSL-hosted phone fixture, not
  a Windows packaged-server code path.

## Deliberately left out

- No production application code, UI layout, toast timing, installed-app database, installed
  server, or user-owned test-instance root was changed.
- No broad environment passthrough was retained; only explicit platform essentials and
  fixture-owned values remain.
- No full-suite run, push, PR, issue mutation, or cleanup of the unrelated
  `env-contract*` ownership roots was performed.
- Graphify output files were refreshed but remain ignored and were not committed.

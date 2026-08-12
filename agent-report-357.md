# Agent report — GitHub issue #357

## Outcome

Implemented issue #357 on `feature/0812-t357-fix` without merging another
feature branch.

The packaged Windows-to-WSL acceptance runner now stores
`protected-integrity-before.json` in a separately marked, runner-owned evidence
root. The launcher never records that root as `wslFixtureRoot`, so
`stop-electron-test-session.ps1 -RemoveData` can continue deleting the provider
fixture and all launcher-owned state before protected-home verification runs.

The runner removes its evidence root after successful verification and from its
`EXIT` cleanup on failures. Removal validates the exact agent home, session ID,
GUID-N ownership token, expected root, and owner marker before deleting. A
manager failure is explicitly propagated even when the cleanup function is
called from a Bash OR-list; the root variable is cleared only after removal
succeeds.

No product runtime, provider fixture, stopper behavior, or protected-invariant
classification changed.

## TDD seams and regression evidence

The implementation used the fixture-only runner/cleanup seam with synthetic
protected homes and provider state.

1. **Evidence lifetime after launcher cleanup.** The test resolves the snapshot
   path selected by `run-acceptance.sh`, captures a real integrity snapshot,
   deletes the provider fixture as `-RemoveData` does, requires the snapshot to
   remain, and runs the real integrity verifier afterward.
2. **Failure cleanup.** A forced exit 19 executes the actual `cleanup` and
   `remove_runner_evidence_root` function bodies from `run-acceptance.sh`, then
   asserts that the runner-owned evidence root is absent while the original exit
   status is preserved.
3. **Removal failure propagation.** The production removal function is invoked
   from an OR-list with a failing manager. The test requires status 1 and the
   unchanged root path, proving the failure cannot be masked by the later
   root-clearing assignment.

Initial red result for the ticket regression:

```text
protected integrity evidence survives provider cleanup until verification
AssertionError: runner-owned integrity snapshot must survive launcher-owned provider cleanup
6 passed, 1 failed
```

Initial red result for the OR-list edge case:

```text
runner evidence removal preserves manager failures in cleanup OR-lists
expected: ["1", "<evidence-root>"]
actual:   ["0", ""]
8 passed, 1 failed
```

After the fixes, the focused fixture suite passed 9/9 on three consecutive runs.
All test data lived in unique roots under `~/.tessera/test-fixtures/`: the main
`unit-<pid>-<timestamp>` fixture plus short-lived
`unit-evidence-<pid>-<timestamp>.runner` and
`unit-failure-<pid>-<timestamp>.runner` siblings. Every root was removed. No real
provider credential, configuration, skill, Tessera database, installed
application, process, or port was changed.

## Implementation

- `tests/fixtures/packaged-windows-wsl/runner-evidence.sh`
  - creates one deterministic runner-owned evidence root per acceptance session;
  - marks it with the independently validated ownership token;
  - removes only the exact expected root when the marker and token match.
- `tests/fixtures/packaged-windows-wsl/run-acceptance.sh`
  - creates the runner evidence root before snapshot capture;
  - keeps the snapshot alive through unchanged `-RemoveData` shutdown cleanup;
  - verifies the snapshot hash and all named protected invariants after shutdown;
  - removes evidence on both success and failure;
  - explicitly propagates evidence-manager removal failures.
- `tests/packaged-windows-wsl-fixture.test.ts`
  - adds behavioral lifetime, failure-cleanup, and OR-list failure regressions;
  - retains the existing runner composition assertions.

## Verification

- `bash -n tests/fixtures/packaged-windows-wsl/run-acceptance.sh tests/fixtures/packaged-windows-wsl/runner-evidence.sh`
  - Passed.
- `npx tsx --test tests/packaged-windows-wsl-fixture.test.ts`
  - Passed repeatedly; final result 9 passed, 0 failed/skipped.
- `npx tsx --test tests/electron-test-launcher-contract.test.mjs`
  - Passed: 13/13.
- `npm run test:contracts`
  - Passed: 378 tests, 0 failures.
- `npm run test:unit`
  - Passed with exit 0.
- `npx tsc --noEmit`
  - Passed with 0 errors.
- `npm run lint`
  - Passed with 0 errors and 3 pre-existing warnings in unrelated files:
    `preview-markdown.tsx`, `use-virtual-message-list.ts`, and
    `spawn-cli-runtime.ts`.
- `git diff --check`
  - Passed.
- `graphify update .`
  - Passed after the final code/test changes.

This worktree initially had no `node_modules`, so the first TypeScript/lint and
`npm run test:contracts` attempts resolved to missing or obsolete global tools.
`npm ci` installed the lockfile-pinned ignored dependencies, after which the
repository checks above passed. No manifest or lockfile changed.

## Code review

Fixed point: `91fad3b8db876892f77b7398c5f96286c6caf1f8`, the integration HEAD from
which this worktree started.

Final implementation commit reviewed:

```text
6c28993 fix: preserve packaged integrity evidence (#357)
```

Diff command: `git diff 91fad3b...HEAD`.

The `$code-review` Standards and Spec axes ran in parallel as independent,
read-only agents.

### Standards

Final result: 0 findings. No hard violations of `AGENTS.md`, `CONTRIBUTING.md`,
or `.claude/notes/electron-isolated-test.md`; no reportable baseline smells.

### Spec

The first review found one P2 test gap: the forced-failure test used its own trap
instead of the production runner cleanup function, so it could pass if the real
failure cleanup call were removed. The finding was fixed by executing the actual
`cleanup` and `remove_runner_evidence_root` bodies in the forced-failure test.

Final result after re-review: 0 findings. No missing requirement, scope creep, or
incorrect implementation remained.

Review summary: Standards 0 findings (worst: none); Spec 0 final findings (the
one initial P2 was fixed and re-reviewed).

## Commit and handoff

- `6c28993` — runner-owned evidence lifecycle, behavioral regressions, and all
  review fixes.
- This report is committed separately so it can cite the stable implementation
  commit.

The full packaged Windows Electron → Windows backend → WSL agent acceptance was
not rerun here. Per issue instructions, the orchestrator owns that expensive
post-integration run. This report therefore claims the deterministic fixture,
static, unit, and contract evidence above, not a new packaged runtime result.

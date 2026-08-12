# Agent report — GitHub issue 355

## Outcome

Implemented the repeatable PowerShell/WSL launcher contract harness for issue 355.
The harness now gives every invocation a collision-free `env-contract-t355-<pid>-<nonce>`
session, reads the actual WSL state roots and owner tokens from the launcher's manifest,
and delegates cleanup to `scripts/stop-electron-test-session.ps1 -RemoveData`. Success,
synthetic child-launch failure, mismatched-owner refusal, and two concurrent harnesses are
covered through the checked-in launcher/stopper boundary.

The harness also owns its Windows temporary root with an exact marker. It removes that root
only after the stop contract removed the session manifest. A failed or mismatched cleanup
therefore leaves evidence intact instead of recursively deleting a path it cannot prove it
owns.

Changed files:

- `tests/fixtures/electron-launch-environment-harness.ps1`
- `tests/electron-test-launcher-contract.test.mjs`

No product launcher or stop-script behavior was changed; the defect was confined to the
contract harness.

## Skill invocation and TDD seams

`$implement` was invoked with GitHub issue 355 as its ticket. Its complete loop was followed:
issue/context inspection, characterization, implementation, targeted and required checks,
`$code-review`, valid-finding application, graph update, and commit.

`/tdd` ran at the user-approved public seam:

`tests/electron-test-launcher-contract.test.mjs` →
`tests/fixtures/electron-launch-environment-harness.ps1` → checked-in real
`launch-electron-test-instances.ps1` and `stop-electron-test-session.ps1` → WSL ownership
marker/filesystem result.

Red first:

- Existing focused command failed its first two launcher tests because prior static
  `env-contract*` roots rejected the new token. At that point the command reported 9 pass,
  3 fail; the third failure was `terminal-contract.test.mjs` missing `zustand` because this
  worktree had no installed dependencies.
- New cleanup/mismatch/parallel tests then failed because the harness had no `-Stopper`
  parameter or mismatch mode.

Green:

- Added success and forced-failure cleanup assertions through manifest-owned roots.
- Added a mismatch cycle that changes a marker only after verifying the exact current token,
  observes stop cleanup fail closed, proves the mismatched marker is unchanged, restores the
  original known token, and uses the same stop contract for final cleanup.
- Added parallel harness execution and distinct-session assertions.
- No requested seam was skipped.

## Commands and measured results

Repository and ticket inspection:

- `gh issue view 355 --repo horang-labs/tessera --comments` — failed because GitHub's
  deprecated Projects Classic GraphQL field is still requested by this `gh` path.
- `gh api repos/horang-labs/tessera/issues/355 ...` — exit 0; issue and acceptance criteria
  read successfully.
- Read `.claude/notes/cross-boundary-testing.md` and
  `.claude/notes/electron-isolated-test.md` before implementation.
- `graphify query "launch-electron-test-instances stop-electron-test-session ownership manifest" --budget 2000`
  — used for initial codebase orientation; direct files were then inspected.
- `npm ci` — exit 0; 1,042 packages installed. The audit summary reported 46 existing
  dependency vulnerabilities (2 low, 13 moderate, 28 high, 3 critical); dependency changes
  were outside this ticket and `package-lock.json` was unchanged.

Focused contract, final code, three consecutive natural exits:

`npx tsx --test tests/electron-test-launcher-contract.test.mjs tests/terminal-contract.test.mjs`

| Run | Tests | Exit | Duration | New owned WSL residue | Pre-existing legacy roots |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 69/69 | 0 | 9.3708 s test / 9.5313 s command | 0 | 3 |
| 2 | 69/69 | 0 | 9.2747 s test / 9.4626 s command | 0 | 3 |
| 3 | 69/69 | 0 | 9.5143 s test / 9.6903 s command | 0 | 3 |

The residue command counted
`/home/work/.tessera/test-instances/env-contract-t355-*`. Each run returned zero.
The three legacy paths present before this work (`env-contract`, `env-contract-1`, and
`env-contract-2`) remained three after every run.

Additional checks on final code:

- `npm run test:contracts` — exit 0, 371/371 passed, 0 failed, 0 skipped,
  natural test duration 10.9908 s (command 11.1244 s).
- `npx tsc --noEmit` — exit 0, 3.3210 s.
- `npm run lint` — exit 0; 0 errors and 3 pre-existing warnings in
  `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`.
- `git diff --check` — exit 0.
- Final Windows temp check — `windows_harness_temp_residue=0`.
- Final owned WSL check — no `env-contract-t355-*` paths.
- `graphify update .` — exit 0; final update reported no code-graph topology changes.

The requested full test suite was deliberately not run in this child worktree. The complete
contract suite was run, as required.

## Runtime-specific review

Invoked `$code-review` against fixed point
`b1b7e50299d441d1e9b68f23ebf98443be496f2d` with:

- `git diff b1b7e50299d441d1e9b68f23ebf98443be496f2d...HEAD`
- `git log b1b7e50299d441d1e9b68f23ebf98443be496f2d..HEAD --oneline`

The skill's two explicitly authorized read-only reviewers ran in parallel.

### Standards

No findings. The reviewer found no hard violation of the repository's documented standards.

### Spec

One finding: the first unique namespace, `env-t355-*`, appeared to sidestep the acceptance
wording that names `env-contract*` residue. Applied: the final namespace is
`env-contract-t355-*`, its shape is asserted, and the final three-run measurements count that
exact owned prefix. The manifest-root assertions remain the authoritative ownership proof.

Summary: Standards 0 findings; Spec 1 finding, applied and reverified.

## What could not be verified

- Live packaged Windows Electron QA was not performed. The ticket explicitly prohibited
  launching or stopping Electron in this child worktree; only the checked-in PowerShell/WSL
  contract harness was exercised. The root orchestrator owns final live packaged QA.
- The full test suite was not run, per the ticket. Targeted tests, the complete contract suite,
  typecheck, and lint were run.
- The three legacy `env-contract*` directories could not safely be removed. They predated this
  run and contain valid but different owner markers, while their Windows manifests were already
  gone. Removing them would violate the requirement to prove exact ownership and preserve a
  pre-existing or mismatched marker. Their marker SHA-256 values were recorded as
  `eb61dbbd...683` (`env-contract`), `9a3d77a0...7e78` (`env-contract-1`), and
  `b6a7aa96...7656` (`env-contract-2`), and the paths were deliberately preserved.

## Deliberately left out

- No edits to product launcher/stop scripts.
- No Electron build, launch, stop, CDP session, screenshots, or live packaged QA.
- No broad process termination and no `pkill -f`.
- No deletion of pre-existing WSL state without its manifest ownership proof.
- No dependency upgrade or audit remediation.
- No push and no pull request.

## Commit

Implementation commit: `f6c20e82ab7ff912aed5c9a669f59a6b4d16f43f`.

This report is committed separately so it can durably name the immutable implementation
commit it describes.

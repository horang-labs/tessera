# Agent report — issue 358

## What changed and why

- Codex lifecycle installation now records which managed-event keys already existed in the authoritative provider home before Tessera materialized its hook.
- Removal deletes an empty managed-event key only when Tessera introduced it. Pre-existing user groups, pre-existing empty event keys, and unrelated top-level configuration are preserved.
- Removal re-inspects the hook document before recording revoked consent or returning `absent`.
- Legacy empty managed-event keys without ownership evidence are reported as `conflict` and are not overwritten. This prevents the prior false-success state without adding a force-overwrite path.
- The packaged Windows-backend/WSL-agent fixture now starts with both `SessionStart` and `UserPromptSubmit` user groups, verifies coexistence after installation, and verifies the exact surviving groups and event-key set after removal.

## `$implement` and `$tdd`

`$implement` was invoked with GitHub issue 358 as the supplied ticket. The implementation loop read the issue, ADRs 0008/0010/0011/0015/0016, and `.claude/notes/cross-boundary-testing.md`; oriented through the existing graph; implemented only the lifecycle-removal acceptance criteria; ran targeted checks; invoked `$code-review`; applied its valid findings; and committed the result.

The pre-agreed `$tdd` seam was the public provider-integration lifecycle API backed by deterministic temporary provider-home and lifecycle-ledger fixture files in `tests/provider-integration-lifecycle.test.ts`.

- First red: `npx tsx --test tests/provider-integration-lifecycle.test.ts` reached 14 passing / 1 failing test. The failing bridged-WSL install → coexistence → remove assertion showed exactly `PreToolUse`, `PermissionRequest`, `PostToolUse`, and `Stop` as unexpected empty arrays.
- First green: the same command reached 15/15 passing after empty Tessera-introduced event keys were removed.
- Review-driven red: the same command reached 14 passing / 2 failing tests. One showed a pre-existing user `PreToolUse: []` was deleted; the other showed legacy residue was reported `absent` instead of `conflict`.
- Review-driven green: the same command reached 16/16 passing after key provenance and legacy-residue handling were added.
- The durable packaged Windows/WSL assertion was updated but not run in this child worktree, as required.

The first attempted red run stopped before assertions because dependencies were absent (`Cannot find module 'pino'`). `npm ci` restored 1,042 packages from the lockfile; the red run above was then measured.

## Exact verification commands and results

- `gh issue view 358 --repo horang-labs/tessera` — failed because the GitHub CLI queried deprecated Projects (classic) metadata.
- `gh issue view 358 --repo horang-labs/tessera --json number,title,body,labels,state,url,author,assignees` — succeeded and supplied the ticket body and acceptance criteria.
- `npx tsx --test tests/provider-integration-lifecycle.test.ts tests/provider-integration-cleanup.test.ts` — 23/23 passed, 0 failed, 455.114 ms.
- `npx tsc --noEmit` — exit 0, no diagnostics.
- `npm run lint` — exit 0 with 0 errors and 3 existing warnings in unrelated files (`preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`).
- `bash -n tests/fixtures/packaged-windows-wsl/run-acceptance.sh && sh -n tests/fixtures/packaged-windows-wsl/setup.sh` — exit 0.
- `git diff --check` — exit 0 before each code commit.
- `graphify update .` — exit 0 after the final source changes; graph rebuilt to 11,462 nodes and 30,285 edges. Graphify warned that `provider-skill-ids.json` produced zero nodes and that community labels could be refreshed; neither warning affects the implementation.

The full test suite was deliberately not run because the ticket explicitly delegates it to the orchestrator after integration.

## `$code-review` invocation and findings

The review fixed point was the starting HEAD, `282a2d1`, with diff command `git diff 282a2d1...HEAD` and initial commit list `72bc5f2 fix(codex): remove lifecycle hook residue (#358)`. The skill's two read-only agents ran in parallel, one for Standards and one for Spec.

### Standards

- Hard violation: unconditional deletion could remove a user-owned empty event key, violating ADR 0010.
- Acceptance coverage gap: packaged removal checked the `UserPromptSubmit` key but not the preserved group content.

Both findings were applied by recording pre-install key ownership and strengthening the packaged assertion.

### Spec

- High: legacy empty residue was still classified as successful `absent`.
- Medium: removal could not distinguish Tessera-created keys from pre-existing empty keys.
- Low: packaged Windows/WSL removal coverage did not verify `UserPromptSubmit` content.

All three findings were applied. Legacy residue without provenance now fails closed as `conflict`; new installs record key provenance; removal is post-verified; and the packaged fixture checks both groups.

Review summary: Standards 2 findings (worst: user configuration deletion); Spec 3 findings (worst: false-success for legacy residue).

## Commits

- `72bc5f2` — initial issue 358 implementation and regression coverage.
- `57a0ac1` — valid `$code-review` findings applied and reverified.

This report is committed separately after the code commits so it can durably name their stable hashes.

## What could not be verified

- The packaged Windows Electron backend → WSL agent topology was not launched or mutated here. The root orchestrator owns the active isolated Windows Electron QA instance and final packaged verification.
- No live Electron instance, real provider home, or real provider credentials were read or changed.
- The full suite was not run in this child worktree by explicit instruction.

## Deliberately left out

- No force-overwrite or force-cleanup path.
- No UI, API-shape, provider-home resolution, unrelated lifecycle, or provider-skill refactor.
- No broad test-suite changes; durable E2E coverage adds only the smallest assertions needed to catch event-key residue and user-group loss.
- No push and no pull request.

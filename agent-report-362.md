# Agent report — GitHub issue #362

## What changed and why

- Added the provider display name to managed `cli_down` transport messages using the existing `CliProvider.getDisplayName()` interface.
- Changed the client `cli_down` presentation to interpolate that provider name instead of the hard-coded `Claude Code` label. Events without provider metadata use the neutral `Agent` fallback.
- Updated English, Korean, Japanese, and Chinese `sessionStopped` translations to accept the provider name.
- Added focused presentation coverage for Claude Code, Codex, and OpenCode.
- Read `docs/adr/0006-cut-over-all-new-codex-launches-to-real-home.md`. This change does not alter launch, home, overlay, fork, copy, or resume policy.

The implementation commit is `32f11e254b29696f68ed41c3db0b2c0245c28ace` (`fix: label cli_down messages by provider (#362)`). The report is committed separately because a tracked file cannot contain the hash of the commit that contains itself.

## `$implement` and `$tdd`

`$implement` was invoked with GitHub issue #362 as the supplied ticket and owned issue reading, characterization, implementation, targeted verification, required review, finding remediation, and commit creation. Its default full-suite step was intentionally overridden by the ticket's explicit instruction not to run the full suite in this child worktree.

The pre-agreed `$tdd` seam was the public `handleIncomingServerMessage()` `cli_down` presentation observed through `useChatStore`. It ran as vertical red → green slices:

1. Codex: the unchanged test failed with actual `Claude Code stopped (exit code: -1): codex process exited` versus expected `Codex stopped ...`, then passed after the first production change.
2. Claude Code: the next test failed with neutral `Agent stopped ...`, then passed after Claude Code identity support.
3. OpenCode: the next test failed with neutral `Agent stopped ...`, then passed after OpenCode identity support.

The first attempted red run could not load the handler because this isolated worktree had no installed `uuid` package. `npm install` installed 1,042 declared packages; rerunning the unchanged test then produced the behavior-red assertion above. The later review refactor preserved the same presentation seam while moving provider-name authority to `CliProvider.getDisplayName()`.

## Commands and measured results

- `gh issue view 362 --repo horang-labs/tessera` — GitHub CLI returned a Projects Classic GraphQL deprecation error.
- `gh issue view 362 --repo horang-labs/tessera --comments --json number,title,body,state,labels,comments,author,url` — succeeded and returned issue #362 with three acceptance criteria.
- `npx tsx --test tests/cli-down-presentation.test.ts` — initial behavior-red run: 0/1 passed; exact Claude Code/Codex label mismatch. Subsequent TDD slice runs reached 1/1, 2/2, and 3/3 passing.
- `npx tsx --test tests/cli-down-presentation.test.ts tests/workflow-progress-parser.test.ts` — 11/11 tests passed.
- `npx tsx --test tests/compact-bar-lifecycle-contract.test.mjs` — 4/4 tests passed.
- Final `npx tsx --test tests/cli-down-presentation.test.ts tests/workflow-progress-parser.test.ts tests/compact-bar-lifecycle-contract.test.mjs && npx tsc --noEmit` — 15/15 tests passed; TypeScript exited 0 with no diagnostics.
- `npm run lint` — exited 0 with 0 errors and 3 pre-existing warnings in `src/components/chat/preview-markdown.tsx`, `src/hooks/use-virtual-message-list.ts`, and `src/lib/cli/spawn-cli-runtime.ts`.
- `git diff --check` — passed before both implementation commits/amends.
- `graphify update .` — succeeded after source changes. Final graph measurement: 11,475 nodes, 30,301 edges, 447 communities. Graphify also reported its existing zero-node warning for `provider-skill-ids.json` and stale community-label advice.

## Review invocation and findings

`$code-review` used fixed point `266e32a7b8910baef642a9e46fbcdf034ab989bd`, command `git diff 266e32a7b8910baef642a9e46fbcdf034ab989bd...HEAD`, issue #362 plus ADR 0006 as the spec, and `AGENTS.md` plus `CONTRIBUTING.md` as standards sources. Its Standards and Spec agents ran in parallel and read-only as explicitly authorized.

First pass against commit `dc95f4d`:

- Standards: one hard finding. The new client-side provider label map duplicated provider identity outside `CliProvider.getDisplayName()`, violating `CONTRIBUTING.md`'s rule to keep provider-specific behavior behind CLI provider interfaces.
- Spec: no findings; all three providers had focused coverage.

The finding was applied by deleting the parallel map and enriching `cli_down` from `provider.getDisplayName()` during managed process exit. The implementation commit was amended to `32f11e254b29696f68ed41c3db0b2c0245c28ace`, then tests, typecheck, lint, and graph update were rerun.

Second pass against the final implementation commit:

- Standards: no hard findings; the reviewer explicitly confirmed the earlier interface violation was resolved.
- Spec: no findings.

Final review summary: Standards 0 findings (worst: none); Spec 0 findings (worst: none).

## What could not be verified

- Packaged Windows Electron UI behavior was not exercised. The ticket forbids building, launching, stopping, or mutating a live Electron instance in this child worktree; the root orchestrator owns final packaged Electron QA.
- The full test suite was not run because the ticket explicitly reserves it for the orchestrator after integration.
- No dev server or live CLI process was started; verification used focused automated presentation, parser, lifecycle-contract, typecheck, and lint checks.

## Deliberately left out

- No changes to Codex real-home or legacy-overlay behavior from ADR 0006.
- No changes to provider parsers' human-readable exit-detail strings, process shutdown semantics, session resume behavior, or unrelated UI branding.
- No cleanup of the three unrelated lint warnings or the Graphify zero-node/community-label notices.
- No full-suite run, Electron build/launch, push, PR creation, or GitHub issue mutation.

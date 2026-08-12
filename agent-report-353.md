# Agent report — GitHub issue 353

## What changed and why

Issue 353 reported that the packaged Windows backend could fail a valid managed Session launch or resume when `wsl.exe` took longer than the Control bridge store's fixed 10 second timeout under transient WSL pressure.

- `src/lib/control/cli-bridge.ts` now uses a bounded 10 second then 30 second launch policy for transient `wsl.exe` startup failures.
- Retries reuse one random ownership ID and one deterministic guest directory. Each attempt atomically replaces the same launcher, so retrying does not create duplicate bridge paths, credentials, or authority grants.
- Only timeouts, transient spawn errors (`EAGAIN`, `EBUSY`, `ENOMEM`, `ETIMEDOUT`), and a small allowlist of resource-pressure NTSTATUS values are retried. Permanent numeric failures such as `STATUS_ACCESS_DENIED` fail fast.
- Failed creation attempts remove their deterministic guest artifact. If that cleanup is also temporarily unavailable, the store retains the ownership ID and the runtime factory retries it during disposal.
- Launch failures preserve a concise actionable stderr cause, while avoiding the generated base64 command in the user-facing error.
- Existing fresh and resumed provider launch cases now assert that all three supported providers traverse the same Control bridge preparation path.

No Project/Session authority scope or audit mutation behavior changed; ADR 0009 and ADR 0014 remain intact.

## `$implement` and `/tdd`

The user supplied issue 353 as the ticket to `$implement`. I loaded `/home/work/.agents/skills/implement/SKILL.md`, read the issue through `gh`, read both supplied ADRs, read `.claude/notes/cross-boundary-testing.md`, and used the existing graphify graph to locate `WslExecutableStore`, `createDefaultWslExecutableStore`, the Control bridge tests, and the shared provider launch path.

The two pre-agreed seams both ran through `/tdd`:

1. Transient-timeout recovery at the default WSL executable store + Control bridge factory boundary.
   - Red: `npx tsx --test --test-name-pattern="transient WSL bridge timeout" tests/control-cli-bridge.test.ts` — 0/1 passed; `createDefaultWslExecutableStore is not a function` demonstrated that no deterministic retry seam existed.
   - Green: the same command — 1/1 passed in 297 ms. It proves two attempts use timeouts `[10000, 30000]`, one ownership ID, one guest artifact, one credential, and one authority grant, all removed by disposal.
2. Persistent-failure cleanup at the same public boundary.
   - Red: `npx tsx --test --test-name-pattern="persistent WSL bridge timeouts" tests/control-cli-bridge.test.ts` — 0/1 passed; the raw `Command failed: wsl.exe ...` error did not meet the actionable-error contract and no owned cleanup existed.
   - Green: `npx tsx --test --test-name-pattern="(transient WSL bridge timeout|persistent WSL bridge timeouts)" tests/control-cli-bridge.test.ts` — 2/2 passed in 276 ms. It proves bounded failure removes guest/host bridge artifacts, managed credential, and authority.

Review-driven follow-up regressions also captured fail-fast access denial with stderr and retention of an ownership ID when immediate cleanup itself times out.

## Commands and measured results

### Ticket and orientation

- `gh issue view 353 --repo horang-labs/tessera` — attempted exactly as requested; `gh` emitted the GitHub Projects classic GraphQL deprecation error before rendering the issue.
- `gh api repos/horang-labs/tessera/issues/353 --jq ...` plus the comments endpoint — succeeded and supplied the issue body, acceptance criteria, and labels.
- `graphify query "wsl bridge executable store timeout retry" --budget 3000` — located `src/lib/control/cli-bridge.ts`, `tests/control-cli-bridge.test.ts`, `src/lib/terminal/provider-launch-module.ts`, and `tests/provider-launch-module.test.ts`.

### Current-behavior characterization

- Initial `npx tsx --test tests/control-cli-bridge.test.ts tests/provider-launch-module.test.ts` could not start because this child worktree had no dependencies (`Cannot find module 'pino'`).
- `npm ci` — installed 1,042 packages from the lockfile; npm reported 46 dependency audit findings. No audit fix was run because it is outside this ticket.
- Repeating `npx tsx --test tests/control-cli-bridge.test.ts tests/provider-launch-module.test.ts` before production changes — 35 passed, 1 failed. The existing real Windows `wsl.exe` to WSL boundary test failed after 10,494 ms at the fixed 10 second bridge-create timeout, reproducing the issue's failure mode without Electron.

### Final targeted verification

- `npx tsx --test tests/control-cli-bridge.test.ts` — 12/12 passed, 0 failed, total 5,192 ms. The existing real Windows-to-WSL executable seam passed; its create/forward/cleanup test took 2,277 ms, and the Windows GUI exit-code bridge test took 2,224 ms.
- `npx tsx --test tests/provider-launch-module.test.ts` — 28/28 passed, 0 failed, total 17,276 ms. This includes fresh and resumed Claude Code, Codex, and OpenCode launches using the common Control bridge path.
- `npx tsc --noEmit` — exit 0, no diagnostics.
- `npm run lint` — exit 0, 0 errors and 3 pre-existing warnings in `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`; none are in the changed files.
- `git diff --check` — exit 0.
- `graphify update .` — exit 0; final graph rebuilt to 11,347 nodes, 30,131 edges, and 432 communities. It retained the existing warning that `provider-skill-ids.json` produces zero nodes.

Per the child-worktree rule, no full unit/contract/full-suite command was run. The orchestrator is expected to run the integrated suite after merging.

## `$code-review` invocation and findings

The initial implementation commit was reviewed with `$code-review` exactly against fixed point `b1b7e50299d441d1e9b68f23ebf98443be496f2d`:

- Diff command: `git diff b1b7e50299d441d1e9b68f23ebf98443be496f2d...HEAD`
- Commit list at review time: `0c4fcc6 fix: make WSL Control bridge startup resilient (#353)`
- Two read-only sub-agents ran in parallel as required: Standards and Spec.

Standards reported one code violation and one verification gap:

- All numeric NTSTATUS values were initially treated as transient, conflicting with the documented fail-fast boundary rule. Fixed by allowlisting only known resource-pressure statuses and adding a non-transient access-denied regression.
- Exact packaged Windows backend + WSL Agent Environment provider QA was absent. This remains intentionally pending for the root orchestrator.

Spec reported two code gaps and the same pending acceptance item:

- A failed cleanup discarded its ownership ID. Fixed by retaining pending ownership and retrying it through runtime disposal.
- Numeric failures discarded actionable stderr. Fixed by including concise stderr in the launch error.
- Packaged actual-provider create/converse/stop/resume QA remains pending by explicit instruction.

No ADR authority/audit violation and no acceptance-relevant scope creep were found. Review fixes are committed in `86c37e1`.

## What could not be verified

- Final packaged Windows Electron/backend + WSL Agent Environment QA with an actual supported provider performing create, converse, stop, and resume. Electron was neither launched nor stopped, as required. The root orchestrator owns this QA.
- The complete unit and contract suites. They were deliberately deferred to the orchestrator's post-integration run under the no-full-suite rule.

The real boundary evidence here is narrower: Windows `wsl.exe` launched the generated guest executable from WSL, crossed back into a Windows host process, preserved cwd/context/arguments/stdin and exit codes, and cleaned up. It does not prove the packaged server topology or an actual provider conversation.

## Commits

- `0c4fcc6` — bounded, single-owned WSL bridge retry and acceptance coverage.
- `86c37e1` — applied `$code-review` findings for fail-fast classification, actionable causes, and retained cleanup ownership.

## Deliberately left out

- No Electron lifecycle operations or packaged-app QA.
- No full test suite in this child worktree.
- No push, PR, issue comment, label change, or remote mutation.
- No changes to Control authority scope, audit storage/presentation, provider-specific behavior, or unrelated dependency/audit findings.
- No unbounded retries: the launch and cleanup policy remains finite.

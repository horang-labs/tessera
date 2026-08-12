# Agent report — issue 364

## Outcome

Implemented the Orca-referenced Codex lifecycle-hook and `tessera-cli` skill setup experience for [issue 364](https://github.com/horang-labs/tessera/issues/364).

- Agent status hooks are enabled by default and reconciled at server startup, after Agent Environment/toggle changes, and immediately before Codex launch. An ordinary absent or stale Tessera hook is installed and verified through Codex's trust API; the pending launch then continues without a failed terminal or manual restart.
- Conflicts, unsupported Codex/trust API, trust failures, and write failures stay fail-closed for Codex only. They now produce a structured recovery card outside terminal output and allocate no Codex runtime.
- Settings exposes the Orca-style **Agent status hooks** control. Disable removes the owned hook and stops reconciliation; re-enable reconciles it. User hooks are preserved, externally modified managed artifacts are never overwritten, and the hook remains inert outside Tessera-managed sessions.
- The optional `tessera-cli` setup is one reusable Settings/onboarding surface with the visible standard Skills CLI command, Copy, an inline WSL/native terminal with preloaded-but-unsubmitted input, completion-driven rescan, Re-check, Installed/up-to-date, Update available/Update, Setup failed/Retry, conflict, and removal states.
- Provider launch no longer inspects, updates, or installs the optional skill. Standard Skills CLI selection and its `.skill-lock.json` are authoritative; discovery derives the lock root from the reported installation so a custom WSL home is not mistaken for a conflict.
- ADRs 0001, 0002, 0004, 0005, 0008, and 0010 were amended for the new policy. ADRs 0003, 0006, 0015, and 0016 remain unchanged.

## `$implement` and `/tdd`

`$implement` expanded the ticket into these implementation seams: provider lifecycle policy/reconciliation, settings persistence and UI, pre-spawn WebSocket recovery messaging, exact terminal-surface input delivery, standard Skills CLI inspection/removal, shared skill setup UI, cross-environment path ownership, ADR updates, and the packaged runtime proof.

The following seams ran through `/tdd` (red test, minimal implementation, then regression pass): default/startup/environment/prelaunch reconciliation; absent-hook continuation and hard-failure no-spawn behavior; structured recovery routing; optional-skill launch independence; Skills CLI runtime-scoped inspection/conflict/update/removal; custom-home lock discovery; completion split across PTY chunks; preloaded input waiting for the exact running surface; and the Setup failed **Retry** UI state.

## Automated verification

No full suite was run in this child worktree, as directed.

1. Targeted tests:

   ```text
   npx tsx --test tests/provider-integration-lifecycle.test.ts tests/codex-provider-integration.test.ts tests/provider-launch-module.test.ts tests/provider-skill-management.test.ts tests/provider-skill-onboarding.test.ts tests/provider-skill-settings-ui.test.tsx tests/terminal-user-input-surface.test.ts tests/codex-lifecycle-settings-policy.test.ts tests/provider-integration-recovery-message.test.ts tests/tessera-cli-skill.test.ts
   ```

   Result: **105 passed, 0 failed, 0 skipped**, 8.402 s.

2. `npx tsc --noEmit`

   Result: exit 0, no diagnostics.

3. `npm run lint`

   Result: repository-wide `eslint .` exit 0 with 0 errors and 3 existing warnings in unrelated files (`preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`).

4. `npm run electron:build:win:debug`

   Result: exit 0. Next production build, Electron TypeScript compile, 8,089-file/172 MB runtime preparation, Windows x64 unpacked packaging, and portable packaging all completed. Final hashes are in `artifacts/issue-364/final-package-sha256.txt`:

   - portable: `d437f9bd548e25aa5fe513f88479861b452c00875199b17c305ef4b02f6de8fb`
   - unpacked `Tessera.exe`: `fa8e0ca2ee871fe71b714691475b1dfaba22f62bf913362b8ce632302e830c24`

5. `graphify update .`

   Result: exit 0; 1,427 files re-extracted, 11,586 nodes and 30,539 edges, with the aggregated graph regenerated. Graphify warned that JSON evidence files yield zero AST nodes, which is expected for non-code evidence.

Both new E2E drivers satisfy the ticket limit: `tests/issue-364-packaged-windows-wsl.e2e.cjs` is 189 lines and `tests/issue-364-runtime-state.e2e.cjs` is 173 lines.

## Packaged Windows Electron + WSL-agent verification

The test followed `.claude/notes/cross-boundary-testing.md`, `.claude/notes/electron-isolated-test.md`, and the repository `tessera-electron-dev` skill. It used the packaged Windows parent and packaged Windows backend, not a Linux dev server:

- final Electron PID: `17736` (`Tessera.exe`, CDP `127.0.0.1:9337`)
- final packaged Windows backend PID: `10468` (`resources/app.asar/dist-electron/electron/server-child.js`, listener `127.0.0.1:32124`)
- `TESSERA_DEV_PORT`: absent (`null` in `artifacts/issue-364/final-runtime-topology.json`)
- WSL distro/agent: `Ubuntu-24.04`, provider terminals launched by `wsl.exe`
- isolated session/owner: `t364-0813-real1` / `e87d7889fe524865a3e67d8e63dbe15b`
- isolated Windows data: `C:\Users\work\AppData\Local\TesseraTestInstances\t364-0813-real1\{data,user-data}`
- isolated WSL fixture: `/home/work/.tessera/test-fixtures/t364-0813-real1`
- authoritative test Codex home: `/home/work/.tessera/test-fixtures/t364-0813-real1/codex-home`
- packaged executable: `C:\Users\work\Downloads\Tessera-0.2.3-hotfix.1-feature-0813-t364-electron-dev-debuglog-20260813-021041-unpacked\Tessera.exe`

The launch command explicitly removed `TESSERA_DEV_PORT` and passed the retained owner-scoped fixture through `TESSERA_ELECTRON_TEST_WSL_FIXTURE_ROOT`; the exact manifest, process command lines, listeners, roots, and hashes are in `artifacts/issue-364/final-runtime-topology.json`.

### Codex lifecycle results

- A fresh custom WSL `CODEX_HOME` began without a Tessera hook. Preflight installed/trusted the hook in that home and continued the first Codex runtime; no `ProviderIntegrationLaunchBlockedError`, `Authoritative Provider Home`, or `Restart` appeared. A real Codex prompt/response completed, with the final rebuilt package again returning exactly `T364_RESPONSE_OK` (`core.json`; an earlier attached exchange is retained in `exchange-existing.json`).
- The isolated user hook remained in order and ran during an external ordinary Codex session. With all Tessera session variables removed, that session returned `EXTERNAL_OK`; the user-hook marker contains both invocations, while the managed hook was a no-op.
- Disable produced `absent`/`revoked` and removed only Tessera's entries; re-enable returned `installed`/`granted`/`trusted`/`healthy` (`hooks-disabled.json`, `hooks-reenabled.json`).
- Forced unsupported version, Codex trust-API write failure, managed-hook conflict, and filesystem write failure each blocked before Codex allocation. Before/after process and hook hashes match in the corresponding evidence files. The corrected trust test reaches `hooks/config/batchWrite`, reports `Codex hook trust failed: issue-364 forced hook trust write failure`, and leaves the before/after Codex process snapshots identical. Recovery cards are captured in `structured-recovery-unsupported.png`, `structured-recovery-trust-write-failure-final.png`, `structured-recovery-conflict.png`, and `structured-recovery-write-failure-final.png`; WebSocket launch output was empty for blocked cases.
- Claude Code and OpenCode both reached a real terminal while Codex lifecycle health was blocked (`claude-independent-runtime.*`, `opencode-independent-runtime.*`).
- The isolated log search found no provider-started or skill-onboarding event before a real runtime. `provider-start-and-onboarding-events.txt` retains the relevant `terminal_started` and structured-block lines for comparison.
- Windows native Codex auth/config/hooks hashes remained exactly at their baseline values (`real-windows-home-final-sha256.json`), proving no opposite-environment mutation. The test-target WSL hook/config/auth hashes are isolated under the fixture. The user's non-target WSL `~/.codex/config.toml` changed concurrently at 03:27:56; it was not the resolved home and is not claimed as test-owned. Its auth and hooks stayed at their baseline hashes. No test mutation was directed there.

### `tessera-cli` results

- Settings showed the exact command and Copy action, opened a WSL inline terminal with it visibly preloaded, and waited for explicit Enter (`skill-before.png`, `skill-command-preloaded.png`).
- The real interactive standard Skills CLI picker selected only Codex and OpenCode in the isolated WSL environment. Completion triggered rescan and reported `installed` (`skill-installed-fixed.json`).
- A lock-backed stale copy reported `update-available`; the visible `npx skills update tessera-cli --global` flow returned it to `installed` (`skill-update-available.*`, `skill-update-command-preloaded.png`, `skill-update.json`).
- External content modification reported `conflict`; the before/after content hashes are identical (`skill-conflict-hash-before.txt`, `skill-conflict-hash-after.txt`).
- A controlled WSL `npx` exit 73 produced `setup-failed` with the exact error and a rendered **Retry** action in the final package (`skill-setup-failed-retry-final.json`, `skill-setup-failed-retry-final.png`).
- Tessera-specific removal went from `installed` to `not-installed`; a later real Codex launch did not reinstall it, and the final panel remained `Not installed` (`skill-removed.json`, `skill-final-absent.*`).
- The final shared onboarding surface rendered the same setup panel as Settings—not a terminal-error banner or redirect-only toast—with WSL context, exact command, Copy, `Not installed`, `Retry setup`, and the explicit “Press Enter” instruction. It opened the inline terminal with the command preloaded (`skill-shared-onboarding-terminal-final.json`, `skill-shared-onboarding-terminal-final.png`).

The complete non-sensitive screenshot/JSON/process/filesystem evidence set is under `artifacts/issue-364/` (109 files, 8.9 MB). The raw preflight WSL process snapshot was moved outside the worktree because it contained unrelated user command lines; `wsl-processes-before-redacted.txt` records that exclusion, while ticket-scoped topology and failure-specific before/after evidence remain. Failed exploratory harness attempts are retained where they explain discovery of the custom-home `.skill-lock.json` bug; the `*-fixed`, `*-final`, and topology artifacts are authoritative.

## Review

`$code-review` was invoked exactly as provided against fixed point `2fb77b28a8943cb187c1ec1f0ac89cc6adb63af9`, with `/root/standards_review_364` and `/root/spec_review_364` running the skill's two axes in parallel.

Standards findings and resolutions:

- Browser-insecure remote contexts could lack `crypto.randomUUID()` and `navigator.clipboard`; setup now has a non-cryptographic UI-ID fallback and a guarded clipboard path, with a regression test.
- A raw WSL process snapshot included unrelated user command lines; it was removed from commit scope and replaced with a redacted explanatory artifact. Ticket-owned PID/process evidence remains exact.

Spec findings and resolutions:

- App-server Codex launches bypassed the disabled-hook policy and did not surface the same structured recovery as PTY launches. The user setting now threads through session preparation and the Codex adapter, preflight errors remain typed, and recovery is routed to the Session card for both runtimes.
- Skill removal could fail open when ownership inspection itself failed. Removal is now all-or-nothing and fail-closed, with a regression test.
- The first trust-failure fixture failed during `hooks/list` instead of the trust write. A dedicated app-server fixture now reaches `hooks/config/batchWrite`; packaged evidence proves the exact trust-write error and no Codex allocation.
- Onboarding was a toast redirect rather than Orca's reusable setup surface, and it omitted explicit Enter/up-to-date language. Settings and onboarding now reuse one panel and the final packaged screenshot proves the inline preloaded-command flow.
- ADR 0004/0005 language still contradicted the explicit standard-CLI/agent-environment policy. The local ticket ADR copies were corrected together with related new-policy amendments.
- Opposite-environment protection lacked a durable before/after baseline comparison. `real-windows-home-baseline-comparison.json` records identical native Windows Codex auth/config/hooks SHA-256 values.

All accepted findings were applied before the final package, real Codex exchange, and final 105-test/type/lint verification.

## Could not be verified

Nothing in the ticket's required packaged Windows Electron + WSL topology was replaced by a browser-only or Linux-backend substitute. All nine required runtime areas were exercised. The first exploratory real Codex prompt encountered Codex's native review for a preserved external user hook; after that external hook was trusted through Codex, the exchange completed. The authoritative final rebuilt-package run started healthy and independently repeated the short real exchange with the exact response `T364_RESPONSE_OK`.

## Deliberately left out

- No full test suite in this child worktree.
- No managed-home or opposite-environment fallback.
- No silent skill installation/update during provider launch and no automatic installation for every provider.
- No overwrite/removal of externally modified hooks or skills.
- No push and no pull request.
- Isolated databases, provider homes, retained package copies, and non-sensitive evidence were preserved for integration review. The isolated runtime was stopped by exact Electron PID `17736`; the cleanup manifest confirms zero owner-scoped Windows processes, zero listeners on ports 9337/32124, and zero fixture-scoped WSL processes.

## Commit

Implementation commit: **PENDING COMMIT**.

The report is updated in a report-only follow-up commit so it can contain the immutable implementation hash without attempting a self-referential hash.

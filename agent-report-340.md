# Agent report — GitHub issue #340

## Completion status

Implementation is complete for issue #340's initial consented Codex lifecycle-hook install/trust/status CLI tracer. The implementation commit is `f0009b7cad3027afe1ed01bec25231c4686e9dea` (`feat: manage consented Codex lifecycle hooks`).

The work is intentionally limited to #340. New-session real-home cutover and launch gating remain in #341. The complete GUI/update/revocation/conflict/degraded lifecycle remains in #343.

## Acceptance mapping

| #340 acceptance criterion | Implementation and evidence |
| --- | --- |
| Consent is explicit and scoped to one Authoritative Provider Home | `tessera provider codex lifecycle install` requires `--consent`; the server also requires `consent: granted`. A Managed Session caller is forbidden from granting the user-global consent. Inspection remains non-mutating, and a different resolved home returns `absent`/consent-required. Covered by the CLI, native lifecycle, home-change, and authorization tests. |
| Existing user-owned hooks are preserved | Installation parses and merges `hooks.json`, appends only the six Tessera handlers, writes atomically, and preserves existing fields, ordering, file mode, and symlink targets. Malformed or Tessera-looking modified artifacts fail closed as conflicts. Covered by coexistence, malformed-config, modified-hook, and symlink/mode tests. |
| Trust uses Codex's supported API | The integration calls `hooks/list`, takes only Codex-reported `currentHash` values, writes them through `config/batchWrite` at `hooks.state`, and calls `hooks/list` again to verify `trustStatus`, `enabled`, command, event, and uniqueness. No Tessera-computed trust hashes or direct trust-config edits are used. |
| Unsupported version/API gives minimum-version guidance and fails closed | Versions below `0.146.0`, or an unavailable hook RPC, report `minimumVersion: 0.146.0` and `updateCommand: codex update`; installation/trust does not proceed. Ordinary permission, timeout, or transport failures do not falsely claim that an update will fix them. |
| CLI reports lifecycle states through Provider Integration | Added `provider codex lifecycle status [--json]` and `provider codex lifecycle install --consent [--json]`, transported through the pinned Control CLI/HTTP/service boundary. Provider Integration reports installed/trusted, absent, unavailable, untrusted/blocked, and conflict states without exposing filesystem paths. |
| Hook is a complete no-op outside a Managed Session | POSIX and Windows hook commands require the Tessera hook port, session ID, and pane token. Without all three coordinates, they drain stdin and exit successfully without invoking curl or contacting Tessera. Covered by the no-op hook test. |
| Native/WSL ownership has no opposite-home fallback | The active user's Agent Environment is loaded strictly. The Codex home is probed from that environment's login shell, including custom `CODEX_HOME`; a failed probe stops instead of guessing. Windows backend + WSL exports the already translated WSL home to the trust app-server and never inspects or writes the Windows Codex home. Covered with isolated native and bridged fake-CLI fixtures. |

## Architecture

- The shared Provider Integration module owns generic lifecycle policy and result mapping. Provider-specific lifecycle operations are exposed through the optional `CliProvider.getLifecycleIntegration()` capability; the shared module contains no Codex ID branch or Codex filesystem implementation.
- `CodexAdapter` supplies the Codex lifecycle integration. `provider-home.ts` resolves exactly one authoritative home from the selected Agent Environment and fails closed when it cannot validate that home.
- `lifecycle-hook-integration.ts` owns inspection, coexistence-safe atomic installation, Codex version checking, supported trust RPC calls, and post-write verification. The trust process is pinned to the same authoritative home used for the hook file.
- Control CLI → pinned runtime HTTP → Control service → Provider Integration is the management path. Installation is an explicit user-scoped operation; session-scoped caller context cannot authorize it.
- The installed lifecycle command reuses the terminal hook endpoint but is inert unless the Managed Session coordinates are present.

## Changed files

CLI and shared/provider seams:

- `bin/control-cli.mjs`
- `src/lib/cli/provider-integration.ts`
- `src/lib/cli/providers/provider-contract.ts`
- `src/lib/cli/providers/types.ts`
- `src/lib/cli/providers/codex/adapter.ts`
- `src/lib/cli/providers/codex/app-server-request-client.ts`
- `src/lib/cli/providers/codex/lifecycle-hook-integration.ts`
- `src/lib/cli/providers/codex/provider-home.ts`
- `src/lib/cli/spawn-cli.ts`

Control/runtime and hook behavior:

- `src/lib/control/http-handler.ts`
- `src/lib/control/provider-integration-manager.ts`
- `src/lib/control/runtime-host.ts`
- `src/lib/control/service.ts`
- `src/lib/terminal/hook-command.ts`
- `src/lib/memory/codex-memory.ts`
- `eslint.config.mjs`

Tests:

- `tests/provider-integration-lifecycle.test.ts`
- `tests/codex-provider-home.test.ts`
- `tests/codex-provider-integration.test.ts`
- `tests/codex-overlay-trust.test.ts`
- `tests/hook-command.test.ts`
- `tests/control-cli-integration.test.ts`
- `tests/memory-bridged-config-home.test.ts`
- `tests/memory-contract.test.mjs`
- `tests/settings-manager-strict.test.ts`

## Exact verification

- `npx tsx --test --test-concurrency=4 tests/provider-integration-lifecycle.test.ts tests/codex-provider-home.test.ts tests/codex-provider-integration.test.ts tests/codex-overlay-trust.test.ts tests/hook-command.test.ts tests/control-cli-integration.test.ts tests/control-http-handler.test.ts tests/control-runtime-host.test.ts tests/control-service.test.ts tests/settings-manager-strict.test.ts tests/memory-bridged-config-home.test.ts tests/memory-contract.test.mjs` — **PASS, 88/88**.
- `npx tsc --noEmit` — **PASS**.
- Targeted ESLint over the review-touched lifecycle, home, provider, Control, and test files — **PASS, 0 errors/warnings**.
- `npm run lint` — **PASS, 0 errors**. Three unrelated pre-existing warnings remain in `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`.
- `npm run build` — **PASS**; optimized Next.js production build, TypeScript, static generation, and trace collection completed.
- `git diff --check` — **PASS**.
- `graphify update .` — **PASS**; graph rebuilt with 10,846 nodes and 28,399 edges after the final implementation changes.

The repository-wide test glob was also attempted. It encounters the pre-existing `tests/active-workspace-session.test.ts` import of missing `buildWorkspaceExplorerSessionId`. The same stale import and missing implementation are present at the fixed review start `675481aa3886bf072f2e51e8802e27d8e77b8308`; it is unrelated to #340 and was not changed. The issue-specific/affected suite above is fully green and uses only temporary homes and fake CLIs.

## Code review against `675481aa3886bf072f2e51e8802e27d8e77b8308`

The `$code-review` Standards and Spec reviews ran in parallel against the fixed start.

Resolved actionable findings:

- Moved Codex lifecycle behavior behind the provider interface, eliminating Codex imports/ID switches from shared Provider Integration.
- Replaced permissive settings fallback with strict Agent Environment loading and an actionable fail-closed Control error.
- Removed the same-filesystem `<home>/.codex` guess after a failed login-environment probe, preserving custom `CODEX_HOME` authority.
- Treat Codex-reported `enabled: false` as unhealthy/conflicted instead of installed/trusted.
- Limit version/update guidance to an old Codex or a genuinely unavailable hook RPC; ordinary trust/status failures remain blocked without false upgrade advice.
- Added the session-scoped authorization guard for the user-global consent mutation.

Reviewed findings deliberately deferred by ticket boundary:

- Launch-time gating/cutover is #341; #340 exposes the management tracer and seam but does not alter new-session launch behavior.
- Durable consent/revocation records and exhaustive recognition of externally rewritten artifacts are part of the complete lifecycle in #343. In #340, explicit `--consent` authorizes only the currently resolved home and exact managed-hook presence is the inspection evidence.
- Exact packaged Windows-backend + WSL-CLI smoke evidence was not produced in this ticket; deterministic bridged fixtures cover path ownership and process environment, while the exact topology gap is recorded below.

No unresolved code finding within #340's authorized scope remains. The exact-topology evidence gap remains explicitly recorded below.

## Cross-boundary gaps

- No packaged Windows Electron/backend + real WSL Codex end-to-end test was run. Such a test would necessarily involve an actual provider home unless a dedicated OS-level fake Codex/home harness is added. This ticket instead uses injected `win32`/WSL probes, isolated temporary provider homes, and fake app-server trust responses; no real user Codex home was read or modified by tests.
- No GUI lifecycle surface was added or tested; that is #343.
- No launch-time real-home cutover or launch blocking was added or tested; that is #341.

## Final status

**Complete for #340.** Implementation commit: `f0009b7cad3027afe1ed01bec25231c4686e9dea`. All affected tests and required build/static checks pass. No push, PR, issue mutation, merge, or other-worktree change was performed.

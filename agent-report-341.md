# Agent report — GitHub issue #341

## Completion status

Complete. New Codex app-server and direct TUI launches now use one authoritative provider
home, while only an exact legacy overlay resume retains the compatibility overlay. Claude Code
and OpenCode behavior is unchanged, and no Codex-owned user state is migrated or copied.

Product commits:

- `b829183` — `feat(codex): launch new sessions from provider home (#341)`
- `5790295` — `fix(codex): bind launch checks to one provider home (#341)`

The implementation starts from the required fixed review point
`74c0d45f50ff7688f638eb8b9c0cfcc626469205` and preserves the already integrated #339,
#340, #347, and #348 provider, lifecycle, authority, and audit contracts.

## Acceptance mapping

| Requirement | Implementation and evidence |
| --- | --- |
| New Codex app-server launches use the authoritative provider home | Codex supplies a provider-owned launch preparation that resolves the home once and returns an environment builder closed over that exact home. App-server startup and short-lived request/model-list clients use the same authority. Native and bridged custom-home tests cover the behavior. |
| New and derived direct TUI launches use the authoritative provider home | The direct TUI launch module obtains the prepared provider environment and removes `TESSERA_CODEX_HOME`, including its `WSLENV` entry. Native and simulated Windows-backend-to-WSL tests assert the actual spawned environment. |
| Preserve exact legacy overlay resumes only | `isExactLegacyCodexOverlayResume()` requires the transcript's legacy overlay owner to equal the requested terminal. Exact resumes retain overlay reconstruction; forks, copies, and other derived launches use the authoritative home. Existing cleanup/failure coverage remains in place. |
| Lifecycle approval and process launch cannot disagree about home | Provider Integration stores one opaque preparation per path-free decision. Lifecycle inspection and environment construction consume that same preparation. The A-then-B resolver regression test proves the resolver is called once and both operations use home A. Missing, malformed, absent, untrusted, or unhealthy required launch integration fails closed with actionable guidance. |
| Provider Integration decisions remain path-free | The shared decision exposes approval/status only; provider home paths remain inside the provider-owned preparation and closures. Tests assert path-free decisions. |
| Do not migrate Codex-owned user state | No auth, configuration, MCP, skill, plugin, history, or other provider-owned files are copied or rewritten. Differential process tests share only the isolated authoritative home and fake Codex binary across Tessera restarts. |
| Keep Claude Code and OpenCode unaffected | Both providers explicitly declare lifecycle, skill, and launch-environment requirements as not applicable/optional. Regression tests prove a Codex launch block does not block either provider. |
| Fast mode remains off | No fast-mode path was changed. `tests/codex-fast-mode-contract.test.mjs` remains green, 8/8 within the final focused run. |

## Architecture

- `ProviderIntegration` owns generic approval policy, not Codex paths. Its mandatory provider
  requirements distinguish required from not-applicable lifecycle and launch capabilities.
- `CodexAdapter.prepareLaunchIntegration()` resolves exactly one authoritative home and binds
  lifecycle inspection plus launch-environment construction to it.
- App-server and TUI launch paths consume that shared preparation. The app-server request
  helper independently resolves the authoritative home only when no prepared home is supplied.
- Legacy compatibility is terminal-identity-specific. It is not inherited by forks, copies,
  or newly derived sessions.
- There is no migration layer: the launched Codex process reads and writes its own selected
  provider home directly.

## Changed files

Provider and launch seams:

- `src/lib/cli/provider-integration.ts`
- `src/lib/cli/provider-session-options-codex.ts`
- `src/lib/cli/providers/provider-contract.ts`
- `src/lib/cli/providers/types.ts`
- `src/lib/cli/providers/codex/adapter.ts`
- `src/lib/cli/providers/codex/app-server-request-client.ts`
- `src/lib/cli/providers/claude-code/adapter.ts`
- `src/lib/cli/providers/opencode/adapter.ts`
- `src/lib/codex-home.ts`
- `src/lib/terminal/provider-launch-module.ts`

Tests and fixtures:

- `tests/codex-provider-home.test.ts`
- `tests/codex-provider-integration.test.ts`
- `tests/provider-integration-lifecycle.test.ts`
- `tests/provider-launch-module.test.ts`
- `tests/fixtures/codex-authoritative-home-harness.ts`

Total product diff: 15 files, 976 insertions, 65 deletions.

## Exact verification

- `npx tsx --test --test-concurrency=1 tests/codex-provider-home.test.ts tests/provider-integration-lifecycle.test.ts tests/codex-provider-integration.test.ts tests/provider-launch-module.test.ts tests/codex-fast-mode-contract.test.mjs` — **PASS, 61/61**.
- `npx tsc --noEmit` — **PASS**.
- Changed-file ESLint — **PASS, 0 errors/warnings**.
- `npm run lint` — **PASS, 0 errors**. Three unrelated existing warnings remain in `src/components/chat/preview-markdown.tsx`, `src/hooks/use-virtual-message-list.ts`, and `src/lib/cli/spawn-cli-runtime.ts`.
- `git diff --check` — **PASS**.
- `graphify update .` — **PASS** after the final source and test edits; 10,965 nodes, 28,672 edges, and 435 communities.

A repository-wide TypeScript/MJS test glob was also attempted with
`npx tsx --test --test-concurrency=1 $(rg --files tests -g '*.test.ts' -g '*.test.mjs' | sort)`.
It reached 322 observed tests before reproducing the unrelated existing
`tests/active-workspace-session.test.ts` failure caused by the missing
`buildWorkspaceExplorerSessionId` export, then remained alive on the existing
`control-session-controller` inotify handle. The hung runner was terminated. No focused or
affected #341 test is failing.

## Code review against `74c0d45f50ff7688f638eb8b9c0cfcc626469205`

The requested `$code-review` ran Standards and Spec reviews in parallel against the fixed
start.

Resolved findings:

- Made provider requirements mandatory and required an explicit launch preparation, removing
  a fail-open route. Claude Code and OpenCode explicitly declare non-applicable capabilities.
- Bound lifecycle approval and process environment to one provider-owned preparation so a
  changing resolver cannot approve home A and launch home B.
- Extended boundary coverage through the production app-server preparation and direct TUI
  seams for a Windows backend with WSL and custom `CODEX_HOME`.
- Added separate Tessera harness processes with distinct Tessera data directories to verify
  restart persistence while sharing only the authoritative provider home and fake Codex.

Final Standards review: **PASS, no actionable findings**.

Final Spec review: **PASS, no actionable findings**.

## Boundary-test scope

The cross-filesystem behavior is covered with deterministic native and simulated
Windows-backend-to-WSL fixtures, custom provider homes, fake Codex processes, and separate
Tessera harness processes. No packaged Windows Electron end-to-end test was run, and no real
user Codex home was read or modified.

## Final status

Issue #341 is complete in this worktree. Product changes and this report are committed
separately. Nothing was merged or pushed, and the GitHub issue was not edited or closed.
